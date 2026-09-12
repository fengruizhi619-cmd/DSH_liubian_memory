# -*- coding: utf-8 -*-
"""MCP: 语义向量模型托管（Codex 子进程生命周期管理）

模型随 Codex 启动、随 Codex 关闭、运行中自动保活。
多实例协调：Codex 同实例下会拉起多套 MCP，本服务通过「原子 owner 锁文件(os.link) +
陈旧锁回收」保证整机只存在一份 llama-server：
- owner（抢到锁的实例）负责拉起、保活并在退出时关闭模型
- 其余实例发现服务健康则「采用」为共享者，退出时不关闭共享模型
- owner 崩溃/关闭后，锁变为陈旧，任意实例可回收锁并重新接管拉起
"""
import ctypes
import json
import os
import subprocess
import threading
import time
import urllib.request
from contextlib import asynccontextmanager

from mcp.server.fastmcp import FastMCP

LLAMA_EXE = r"E:\llama.cpp\llama-server.exe"
DEFAULT_MODEL = r"E:\llama.cpp\models\qwen3-emb\Qwen3-Embedding-0.6B-Q8_0.gguf"
DEFAULT_PORT = 8082
EMBED_MODEL_NAME = "qwen3-emb"

_PORT = int(os.environ.get("EMBED_PORT", DEFAULT_PORT))
_MODEL_PATH = os.environ.get("EMBED_MODEL", DEFAULT_MODEL)
_EMBED_URL = f"http://127.0.0.1:{_PORT}/v1/embeddings"
_HERE = os.path.dirname(os.path.abspath(__file__))
_LOG = os.path.join(_HERE, "embed_mcp.log")
_ERR = os.path.join(_HERE, "embed_server.err.log")
_LOCK_DIR = r"E:\DSH_data\.memory_registry"
_LOCK_FILE = os.path.join(_LOCK_DIR, "embed_owner.lock")

JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000
JobObjectExtendedLimitInformation = 9
GRACE = 180  # 模型加载宽限期（秒）


def _log(msg):
    try:
        with open(_LOG, "a", encoding="utf-8") as f:
            f.write(f"[{time.strftime('%H:%M:%S')}] {msg}\n")
    except Exception:
        pass


def _taskkill(pid):
    try:
        subprocess.run(["taskkill", "/PID", str(pid), "/T", "/F"],
                       creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
                       capture_output=True, timeout=20)
    except Exception:
        pass


def _clear_owner():
    try:
        if os.path.exists(_LOCK_FILE):
            os.remove(_LOCK_FILE)
    except Exception:
        pass


def _assign_kill_on_close_job(proc):
    """把子进程放入 KILL_ON_JOB_CLOSE 作业：本进程被强杀时子进程一并终止。"""
    try:
        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)

        class _IO_COUNTERS(ctypes.Structure):
            _fields_ = [("ReadOperationCount", ctypes.c_ulonglong),
                        ("WriteOperationCount", ctypes.c_ulonglong),
                        ("OtherOperationCount", ctypes.c_ulonglong),
                        ("ReadTransferCount", ctypes.c_ulonglong),
                        ("WriteTransferCount", ctypes.c_ulonglong),
                        ("OtherTransferCount", ctypes.c_ulonglong)]

        class _BLI(ctypes.Structure):
            _fields_ = [("PerProcessUserTimeLimit", ctypes.c_longlong),
                        ("PerJobUserTimeLimit", ctypes.c_longlong),
                        ("LimitFlags", ctypes.c_ulong),
                        ("MinimumWorkingSetSize", ctypes.c_size_t),
                        ("MaximumWorkingSetSize", ctypes.c_size_t),
                        ("ActiveProcessLimit", ctypes.c_ulong),
                        ("Affinity", ctypes.POINTER(ctypes.c_ulong)),
                        ("PriorityClass", ctypes.c_ulong),
                        ("SchedulingClass", ctypes.c_ulong)]

        class _ELI(ctypes.Structure):
            _fields_ = [("BasicLimitInformation", _BLI),
                        ("IoInfo", _IO_COUNTERS),
                        ("ProcessMemoryLimit", ctypes.c_size_t),
                        ("JobMemoryLimit", ctypes.c_size_t),
                        ("PeakProcessMemoryUsed", ctypes.c_size_t),
                        ("PeakJobMemoryUsed", ctypes.c_size_t)]

        job = kernel32.CreateJobObjectW(None, None)
        if not job:
            return None
        info = _ELI()
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        ok = kernel32.SetInformationJobObject(
            job, JobObjectExtendedLimitInformation,
            ctypes.byref(info), ctypes.sizeof(info))
        if not ok:
            kernel32.CloseHandle(job)
            return None
        if not kernel32.AssignProcessToJobObject(job, int(proc._handle)):
            kernel32.CloseHandle(job)
            return None
        return job
    except Exception as e:
        _log(f"Job Object 设置失败(不影响正常关闭): {e}")
        return None


class EmbedManager:
    def __init__(self):
        self._proc = None          # 自拉的 llama-server 子进程
        self._adopted = None       # 采用的外部 llama-server pid（共享）
        self._owner = False        # 是否为本机的 owner（唯一负责关闭模型者）
        self._job = None           # Windows 作业对象
        self._errf = None          # 子进程 stderr 重定向文件
        self._lock = threading.Lock()
        self._stop = threading.Event()
        self._thread = None
        self._grace_deadline = 0.0
        self._started = time.time()

    # ---------- 健康检查 ----------
    @staticmethod
    def service_healthy(timeout=6):
        try:
            payload = {"model": EMBED_MODEL_NAME, "input": ["ping"]}
            req = urllib.request.Request(
                _EMBED_URL, data=json.dumps(payload).encode("utf-8"),
                headers={"Content-Type": "application/json"})
            with urllib.request.urlopen(req, timeout=timeout) as r:
                data = json.loads(r.read().decode("utf-8"))
            return bool(data.get("data"))
        except Exception:
            return False

    @staticmethod
    def listener_pid():
        try:
            import psutil
        except Exception:
            return None
        try:
            for c in psutil.net_connections(kind="tcp"):
                if c.laddr and c.laddr.port == _PORT and c.status == "LISTEN":
                    return c.pid
        except Exception:
            pass
        return None

    # ---------- 所有权（原子锁：os.link 目标不存在才成功） ----------
    def _lock_owner_pid(self):
        """读锁内容得到 owner pid；内容不可读/损坏返回 None。"""
        try:
            with open(_LOCK_FILE, encoding="utf-8") as f:
                info = json.load(f)
            return info.get("pid")
        except Exception:
            return None

    def _lock_stale(self):
        pid = self._lock_owner_pid()
        if pid is None:
            return False  # 不可读 → 视为正在写入/未知，不抢（安全）
        try:
            import psutil
            if not psutil.pid_exists(pid):
                return True  # owner pid 不存在 → 陈旧可回收
            # 防 pid 复用：owner 必须是 mcp_embed 的 python 进程
            try:
                pr = psutil.Process(pid)
                cmd = " ".join(pr.cmdline() or [])
                if "mcp_embed" not in cmd:
                    return True  # pid 被复用为无关进程（如 svchost）→ 视作陈旧
            except Exception:
                return True
            return False  # owner（mcp_embed 进程）存活
        except Exception:
            return True

    def _claim_owner(self):
        """原子抢占 owner 锁。锁文件始终含完整内容（先写临时文件再 os.link）。"""
        try:
            os.makedirs(_LOCK_DIR, exist_ok=True)
        except Exception:
            pass
        myinfo = {"pid": os.getpid(), "time": int(time.time()), "port": _PORT}
        tmp = _LOCK_FILE + ".tmp%d" % os.getpid()
        try:
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(myinfo, f)
        except Exception:
            return False
        try:
            for _ in range(2):
                try:
                    os.link(tmp, _LOCK_FILE)   # 目标已存在 → FileExistsError
                    self._owner = True
                    _log(f"本实例成为 owner（pid={os.getpid()}）")
                    return True
                except FileExistsError:
                    if self._lock_stale():
                        try:
                            os.remove(_LOCK_FILE)
                            _log("回收陈旧 owner 锁")
                            continue
                        except OSError:
                            return False
                    return False
            return False
        finally:
            try:
                if os.path.exists(tmp):
                    os.remove(tmp)
            except Exception:
                pass

    # ---------- 生命周期 ----------
    def start(self):
        with self._lock:
            if self.service_healthy():
                self._adopted = self.listener_pid()
                self._owner = False
                self._grace_deadline = time.time() + GRACE
                _log(f"采用已有嵌入服务 pid={self._adopted}（共享，非owner）")
            elif self._claim_owner():
                self._kill_orphan_listeners()
                self._spawn_locked()
            else:
                self._adopted = self.listener_pid() or None
                self._owner = False
                self._grace_deadline = time.time() + GRACE
                _log("owner 锁被占用，等待既有实例加载后采用（非owner）")
        self._thread = threading.Thread(target=self._monitor, daemon=True,
                                        name="embed-monitor")
        self._thread.start()
        _log("托管线程已启动")

    def shutdown(self):
        _log("收到停机指令")
        self._stop.set()
        with self._lock:
            if self._owner:
                _log("owner 停机：关闭模型并清锁")
                self._cleanup_locked()
                _clear_owner()
            else:
                _log("非 owner 停机：不动共享模型，仅停止监控")
                self._proc = None
                self._adopted = None
        if self._job:
            try:
                ctypes.WinDLL("kernel32").CloseHandle(self._job)
            except Exception:
                pass
        _log("托管已停止")

    def _kill_orphan_listeners(self):
        """owner 接管前清理端口残留（死owner留下的孤儿模型）。"""
        pid = self.listener_pid()
        if pid and not (self._proc and self._proc.pid == pid):
            _log(f"清理端口残留监听 pid={pid}")
            _taskkill(pid)

    def _rotate_err_log(self, max_mb=10):
        """err 日志超过阈值则轮转，避免无限增长（磁盘累积）"""
        try:
            if not os.path.exists(_ERR):
                return
            if os.path.getsize(_ERR) <= max_mb * 1024 * 1024:
                return
            bak = _ERR + ".old"
            try:
                if os.path.exists(bak):
                    os.remove(bak)
            except OSError:
                pass
            try:
                os.rename(_ERR, bak)
                _log(f"err 日志超过 {max_mb}MB，已轮转为 {os.path.basename(bak)}")
            except OSError:
                try:
                    with open(_ERR, "r+b") as f:
                        f.truncate(0)
                    _log("err 日志超过阈值，已就地截断")
                except Exception as e:
                    _log(f"err 日志轮转失败: {e}")
        except Exception as e:
            _log(f"_rotate_err_log 异常: {e}")

    def _spawn_locked(self):
        if self._stop.is_set():
            return
        self._rotate_err_log()
        cmd = [LLAMA_EXE, "-m", _MODEL_PATH, "--host", "127.0.0.1",
               "--port", str(_PORT), "-c", "8192", "-ngl", "99", "--embeddings"]
        _log("启动 llama-server: " + " ".join(cmd))
        try:
            if self._errf is None or self._errf.closed:
                self._errf = open(_ERR, "a", encoding="utf-8", errors="replace")
            self._proc = subprocess.Popen(
                cmd, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
                stdout=subprocess.DEVNULL, stderr=self._errf)
        except Exception as e:
            _log(f"启动失败: {e}")
            self._proc = None
            return
        self._adopted = None
        self._owner = True
        self._grace_deadline = time.time() + GRACE
        self._job = _assign_kill_on_close_job(self._proc)
        if self._proc.poll() is not None:
            _log(f"llama-server 启动后立即退出 code={self._proc.returncode}（端口可能被占用）")
            self._grace_deadline = time.time() + 15
        _log(f"已拉起 llama-server pid={self._proc.pid} job={bool(self._job)}")

    def _cleanup_locked(self):
        if self._proc is not None and self._proc.poll() is None:
            _log(f"终止子进程 llama-server pid={self._proc.pid}")
            try:
                self._proc.terminate()
                try:
                    self._proc.wait(timeout=15)
                except Exception:
                    self._proc.kill()
            except Exception as e:
                _log(f"终止子进程异常: {e}")
        self._proc = None
        if self._adopted:
            _log(f"终止采用的服务 pid={self._adopted}")
            _taskkill(self._adopted)
            self._adopted = None
        if self._errf is not None and not self._errf.closed:
            try:
                self._errf.close()
            except Exception:
                pass
            self._errf = None

    def _monitor(self):
        while not self._stop.wait(15):
            if self.service_healthy():
                continue
            if time.time() < self._grace_deadline:
                continue  # 仍在加载模型或容错期内
            with self._lock:
                if self._stop.is_set():
                    break
                _log("嵌入服务不可用，尝试接管/重启")
                if self._owner or self._claim_owner():
                    self._kill_orphan_listeners()
                    self._cleanup_locked()
                    self._spawn_locked()
                else:
                    self._grace_deadline = time.time() + 60
        _log("托管线程退出")

    def status_text(self):
        healthy = self.service_healthy()
        pid = self.listener_pid()
        with self._lock:
            if self._proc is not None and self._proc.poll() is None:
                managed = f"子进程 pid={self._proc.pid}"
            elif self._adopted:
                managed = f"采用 pid={self._adopted}"
            else:
                managed = "未托管"
            role = "owner" if self._owner else "共享"
        return (f"在线: {'是' if healthy else '否'} | 端口: {_PORT} | 监听pid: {pid}"
                f" | 托管: {managed} | 角色: {role} | 运行时长: {int(time.time() - self._started)}s")


manager = EmbedManager()


@asynccontextmanager
async def embed_lifespan(_app):
    manager.start()
    yield {"embed": manager}
    manager.shutdown()


mcp = FastMCP(
    "mcp-embed-model",
    instructions=("语义向量模型托管服务：模型随 Codex 启动、随 Codex 关闭，运行中自动保活。"
                  "多实例共享：仅 owner 负责拉起/关闭模型。embed_status 查看状态，embed_restart 强制重启。"),
    lifespan=embed_lifespan,
)


@mcp.tool()
def embed_status() -> str:
    """查看语义向量模型服务状态（是否在线/监听pid/托管方式/角色/运行时长）。"""
    return manager.status_text()


@mcp.tool()
def embed_restart() -> str:
    """强制重启语义向量模型（先杀后拉；仅 owner 执行，其余实例自动跟随共享）。"""
    with manager._lock:
        if not manager._owner and not manager._claim_owner():
            return "非owner且锁被占用，无法重启（由 owner 实例负责）"
        manager._kill_orphan_listeners()
        manager._cleanup_locked()
        manager._spawn_locked()
    return "已触发重启（本实例成为 owner）"


if __name__ == "__main__":
    from mcp_guard import start as _guard
    _guard()
    _log("MCP 服务启动")
    mcp.run(transport="stdio")
    _log("MCP 服务退出")
