# -*- coding: utf-8 -*-
"""流变系统管理面板（本地桌面版 · PyQt5）

主菜单三项：
  1. 系统用户管理：创建新用户 / 查看登录密码与哈希密码 / 删除用户
  2. 被炉系统：选择现有被炉房间，本地查看消息、成员、待办，并可作为管理员发言
  3. Skill 管理：查看全部技能 / 每个用户装载了什么技能

仅真人管理员使用，绑定本机。
用法：python liubian_panel_qt.py
"""
import json
import os
import re
import subprocess
import sys
import time
from datetime import datetime
from pathlib import Path

from PyQt5.QtCore import Qt, QThread, QTimer, QEvent, QSize, pyqtSignal
import sys as _sys
_sys.path.insert(0, r"C:\Users\Feng\.codex\skills\memory-skill\scripts")
import memory_db

from PyQt5.QtGui import QIcon, QPixmap


from PyQt5.QtWidgets import (
    QApplication, QMainWindow, QWidget, QHBoxLayout, QVBoxLayout,
    QListWidget, QStackedWidget, QGroupBox, QLabel, QLineEdit, QPushButton,
    QTableWidget, QTableWidgetItem, QComboBox, QTextEdit, QMessageBox,
    QHeaderView, QSplitter, QScrollArea, QFrame, QPlainTextEdit, QListWidget,
    QStyledItemDelegate, QToolButton, QAbstractItemView, QListWidgetItem,
)

ROOT = Path(__file__).resolve().parent
REGISTRY = Path(r"E:\DSH_data\.memory_registry")
TRACKER = Path(r"C:\Users\Feng\.codex\skills\.skill_tracker")
SKILLS_DIR = Path(r"C:\Users\Feng\.codex\skills")
MEMORY_PY = Path(r"C:\Users\Feng\.codex\skills\memory-skill\scripts\memory.py")
CODEX_DATA = Path(r"E:\codex_data")


def resource_path(rel):
    base = getattr(sys, "_MEIPASS", None)
    if base:
        return Path(base) / rel
    return Path(__file__).resolve().parent.parent / rel  # scripts/ 上一级为技能根目录


ICON_DIR = resource_path("icons")


def safe_int(v, default=0):
    try:
        return int(v)
    except Exception:
        return default


def safe_list(v):
    return [x for x in v if isinstance(x, dict)] if isinstance(v, list) else []


def set_btn_icon(btn, name, size=18):
    p = ICON_DIR / name
    if p.exists():
        btn.setIcon(QIcon(str(p)))
        btn.setIconSize(QSize(size, size))

STYLE = """
QMainWindow{background:#f5f6f8}
QWidget{font-family:"Microsoft YaHei";font-size:17px;color:#222}
QListWidget{background:#2f3542;color:#eef2f6;border:0;font-size:17px;padding:8px 0}
QListWidget::item{padding:14px 16px}
QListWidget::item:selected{background:#3a5a8c}
QGroupBox{background:#fff;border:1px solid #e3e6ea;border-radius:8px;margin-top:10px;padding:12px}
QGroupBox::title{subcontrol-origin:margin;left:12px;padding:0 4px;color:#3a5a8c}
QTableWidget{background:#fff;gridline-color:#eef1f5;border:1px solid #e3e6ea}
QHeaderView::section{background:#eef1f5;border:0;border-bottom:1px solid #d5dbe3;padding:6px}
QLineEdit,QComboBox,QTextEdit{border:1px solid #c5ccd6;border-radius:4px;padding:5px 8px;background:#fff}
QPushButton{background:#3a5a8c;color:#fff;border:0;border-radius:4px;padding:6px 16px}
QPushButton:hover{background:#2f4a74}
QPushButton:danger{background:#b0403f}
QPushButton:disabled{background:#aab6c6}
"""


def load_json(path, default=None):
    p = Path(path)
    if p.exists():
        try:
            return json.loads(p.read_text(encoding="utf-8-sig"))
        except Exception:
            pass
    return default if default is not None else {}


def read_skill_intro(folder):
    """读取技能文件夹 SKILL.md 的 name 与 description 简介"""
    p = SKILLS_DIR / folder / "SKILL.md"
    if not p.exists():
        return folder + "\n\n（无 SKILL.md）"
    txt = p.read_text(encoding="utf-8", errors="replace")
    m = re.search(r"^---\s*\n(.*?)\n---", txt, re.S | re.M)
    head = m.group(1) if m else txt[:500]
    nm = re.search(r"^name:\s*(.+)$", head, re.M)
    dm = re.search(r"^description:\s*(.+)$", head, re.M)
    if dm:
        d = dm.group(1).strip()
        if d in (">", "|"):
            lines = head.splitlines()
            i = next((k for k, l in enumerate(lines) if l.startswith("description:")), -1)
            block = []
            for l in lines[i + 1:]:
                if l.startswith(" ") or l.startswith("\t"):
                    block.append(l.strip())
                elif not l.strip() and block:
                    continue
                else:
                    break
            d = "\n".join(block) or d
        else:
            d = d.strip(chr(34) + chr(39))
    else:
        d = "（无 description）"
    name = nm.group(1).strip() if nm else folder
    return name + "\n\n" + d


PYTHON_EXE = r"E:\python\python.exe"


def run_memory(args):
    # 本机固定 Python（frozen exe 中 sys.executable 是面板自身，_base_executable 不可靠）
    py = PYTHON_EXE if os.path.exists(PYTHON_EXE) else (getattr(sys, "_base_executable", None) or sys.executable)
    cmd = [py, "-X", "utf8", str(MEMORY_PY)] + args
    try:
        r = subprocess.run(cmd, capture_output=True, text=True,
                           encoding="utf-8", timeout=30,
                           cwd=r"E:\codex_data\skill学院",
                           creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        return (r.stdout or "") + (r.stderr or "")
    except Exception as e:
        return f"执行失败: {e}"


class CmdThread(QThread):
    """后台执行 memory.py 命令，避免阻塞 UI"""
    done = pyqtSignal(str)

    def __init__(self, args, parent=None):
        super().__init__(parent)
        self.args = args

    def run(self):
        self.done.emit(run_memory(self.args))


def clean_user_key(name):
    """删除用户后清理各工作区记忆（SQLite）的 last_key_<name>（保留日记索引）"""
    key = "last_key_" + name
    for ws in memory_db.list_workspaces():
        try:
            idx = memory_db.get_workspace_index(ws)
            if key in idx:
                del idx[key]
                memory_db.save_workspace_index(ws, idx)
        except Exception:
            pass


def list_workspaces():
    return sorted(d.name for d in CODEX_DATA.iterdir()
                  if d.is_dir() and (d / "memory" / "index.json").exists())


# ---------- 密码找回（8位数字暴力检索） ----------

COMMON_PWDS = ["00000000", "12345678", "87654321", "88888888", "66666666",
               "11111111", "22222222", "33333333", "44444444", "55555555",
               "77777777", "99999999", "11223344", "12344321", "13572468"]


def scan_range(args):
    start, end, pwd_hash = args
    import hashlib
    for n in range(start, end):
        p = "%08d" % n
        if hashlib.sha256(p.encode()).hexdigest() == pwd_hash:
            return p
    return None


def recover_password(pwd_hash, timeout=90):
    """先查常见密码，再并行全量扫描 00000000-99999999。返回明文或 None。"""
    import hashlib
    for p in COMMON_PWDS:
        if hashlib.sha256(p.encode()).hexdigest() == pwd_hash:
            return p
    from concurrent.futures import ProcessPoolExecutor
    cores = max(2, (__import__("os").cpu_count() or 4) - 1)
    chunk = 10 ** 8 // cores
    deadline = time.time() + timeout
    with ProcessPoolExecutor(max_workers=cores) as ex:
        futs = [ex.submit(scan_range, (i * chunk, (i + 1) * chunk, pwd_hash))
                for i in range(cores)]
        for f in futs:
            remain = deadline - time.time()
            if remain <= 0:
                break
            try:
                r = f.result(timeout=remain)
            except Exception:
                r = None
            if r:
                return r
    return None


class RecoverThread(QThread):
    done = pyqtSignal(str)

    def __init__(self, pwd_hash, parent=None):
        super().__init__(parent)
        self.pwd_hash = pwd_hash

    def run(self):
        r = recover_password(self.pwd_hash)
        self.done.emit(r if r else "")


# ---------- 系统用户管理页 ----------

class UsersPage(QWidget):
    def __init__(self, parent=None):
        super().__init__(parent)
        self._build()
        self.refresh()

    def _build(self):
        lay = QVBoxLayout(self)

        create = QGroupBox("创建新用户")
        c = QHBoxLayout(create)
        c.addWidget(QLabel("用户名（花名）"))
        self.new_name = QLineEdit()
        self.new_name.setPlaceholderText("如：梅花")
        c.addWidget(self.new_name, 2)
        c.addWidget(QLabel("密码（8位数字）"))
        self.new_pwd = QLineEdit()
        self.new_pwd.setPlaceholderText("8位数字，非00000000")
        c.addWidget(self.new_pwd, 2)
        self.btn_create = QPushButton("创建")
        set_btn_icon(self.btn_create, "btn_create.png")
        self.btn_create.clicked.connect(self.create_user)
        c.addWidget(self.btn_create)
        lay.addWidget(create)

        self.table = QTableWidget(0, 6)
        self.table.setHorizontalHeaderLabels(
            ["用户名", "注册日期", "注册ID", "工作区", "技能同步", "密钥前8位"])
        self.table.horizontalHeader().setSectionResizeMode(QHeaderView.Stretch)
        self.table.setSelectionBehavior(QTableWidget.SelectRows)
        lay.addWidget(self.table, 3)

        view = QGroupBox("查看 / 删除用户")
        v = QHBoxLayout(view)
        v.addWidget(QLabel("用户名"))
        self.view_name = QLineEdit()
        self.view_name.setPlaceholderText("输入或从上方表格选择")
        v.addWidget(self.view_name, 2)
        self.btn_pwd = QPushButton("查看登录密码(8位)")
        self.btn_pwd.clicked.connect(self.view_login_pwd)
        v.addWidget(self.btn_pwd)
        self.btn_key = QPushButton("查看哈希密码(KEY)")
        self.btn_key.clicked.connect(self.view_key)
        v.addWidget(self.btn_key)
        self.btn_hash = QPushButton("查看密码哈希")
        self.btn_hash.clicked.connect(self.view_pwd_hash)
        v.addWidget(self.btn_hash)
        self.btn_del = QPushButton("删除用户")
        set_btn_icon(self.btn_del, "btn_delete.png")
        self.btn_del.setProperty("danger", True)
        self.btn_del.setStyleSheet("background:#b0403f;color:#fff;border:0;border-radius:4px;padding:6px 16px")
        self.btn_del.clicked.connect(self.delete_user)
        v.addWidget(self.btn_del)
        lay.addWidget(view)

        self.result = QTextEdit()
        self.result.setReadOnly(True)
        self.result.setFixedHeight(90)
        lay.addWidget(self.result)

        self.table.itemSelectionChanged.connect(self._on_select)

    def _on_select(self):
        row = self.table.currentRow()
        if row >= 0:
            self.view_name.setText(self.table.item(row, 0).text())

    def refresh(self):
        users = memory_db.get_users().get("users", {})
        agents = {k.split(":", 1)[1] for k in memory_db.keys_with_prefix("agent_versions:")}
        self.table.setRowCount(len(users))
        for r, (name, meta) in enumerate(sorted(users.items())):
            vals = [name, meta.get("created", ""), meta.get("created_id", ""),
                    meta.get("home", "-"), "有" if name in agents else "-",
                    meta.get("last_key", "")[:8]]
            for c, v in enumerate(vals):
                self.table.setItem(r, c, QTableWidgetItem(str(v)))

    def _sel_name(self):
        n = self.view_name.text().strip()
        if not n:
            QMessageBox.warning(self, "提示", "请先输入或选择用户名")
        return n

    def create_user(self):
        name = self.new_name.text().strip()
        pwd = self.new_pwd.text().strip()
        if not name or not (len(pwd) == 8 and pwd.isdigit()):
            QMessageBox.warning(self, "提示", "用户名和8位数字密码必填")
            return
        out = run_memory(["register", "--name", name, "--password", pwd])
        QMessageBox.information(self, "创建结果", out.strip() or "（无输出）")
        self.refresh()

    def view_login_pwd(self):
        name = self._sel_name()
        if not name:
            return
        users = memory_db.get_users().get("users", {})
        h = (users.get(name) or {}).get("pwd", "")
        if not h:
            self.result.setPlainText(f"[{name}] 无密码哈希（可能是免密账户）")
            return
        self.result.setPlainText(f"[{name}] 正在检索8位登录密码（常见密码+全量扫描，约15-30秒）...")
        self.btn_pwd.setEnabled(False)
        self._t = RecoverThread(h, self)
        self._t.done.connect(lambda p: self._pwd_result(name, p))
        self._t.start()

    def _pwd_result(self, name, pwd):
        self.btn_pwd.setEnabled(True)
        if pwd:
            self.result.setPlainText(f"[{name}] 登录密码（8位）: {pwd}")
        else:
            self.result.setPlainText(f"[{name}] 未能在时限内检索到密码（哈希较长或非8位数字）")

    def view_key(self):
        name = self._sel_name()
        if not name:
            return
        users = memory_db.get_users().get("users", {})
        key = (users.get(name) or {}).get("last_key", "")
        self.result.setPlainText(f"[{name}] 哈希密码（KEY）: {key or '（无）'}")

    def view_pwd_hash(self):
        name = self._sel_name()
        if not name:
            return
        users = memory_db.get_users().get("users", {})
        h = (users.get(name) or {}).get("pwd", "")
        self.result.setPlainText(f"[{name}] 密码哈希（sha256）: {h or '（无）'}")

    def delete_user(self):
        name = self._sel_name()
        if not name:
            return
        if QMessageBox.question(self, "确认删除",
                                f"确认删除用户 {name}？\n此操作不可逆（日记文件保留）",
                                QMessageBox.Yes | QMessageBox.No) != QMessageBox.Yes:
            return
        self.btn_del.setEnabled(False)
        self.result.setPlainText(f"正在删除 {name} ...")
        self._del_name = name
        self._del_thread = CmdThread(["delete-user", "-u", name, "--confirm"], self)
        self._del_thread.done.connect(self._del_done)
        self._del_thread.start()

    def _del_done(self, out):
        clean_user_key(self._del_name)
        self.btn_del.setEnabled(True)
        self.result.setPlainText(out.strip() or "（已删除）")
        self.view_name.clear()
        self.refresh()


# ---------- 被炉系统页 ----------

class WrapItemDelegate(QStyledItemDelegate):
    """列表项自动换行并按内容高度撑开行高，避免长文本被截断"""

    def sizeHint(self, option, index):
        text = index.data(Qt.DisplayRole) or ""
        fm = option.fontMetrics
        width = max(option.rect.width(), 240)
        r = fm.boundingRect(0, 0, width - 14, 100000, Qt.TextWordWrap, text)
        return QSize(r.width() + 14, r.height() + 12)


class MessageBubble(QFrame):
    SENDER_COLORS = ["#2b6cb0", "#2f855a", "#b7791f", "#9f5f1f",
                     "#6b46c1", "#c53030", "#319795", "#234e52"]

    def __init__(self, name, mid, time_str, content, read_by=(), parent=None):
        super().__init__(parent)
        self.msg_id = mid
        mine = (name == "管理员")
        bg = "#c9e4b6" if mine else "#e3edf7"
        self.setStyleSheet("QFrame{background:%s;border-radius:10px;}" % bg)
        outer = QVBoxLayout(self)
        outer.setContentsMargins(10, 6, 10, 6)
        head = QHBoxLayout()
        av = QLabel()
        ap = ICON_DIR / ("avatar_admin.png" if mine else "avatar_user.png")
        if ap.exists():
            av.setPixmap(QPixmap(str(ap)).scaled(30, 30, Qt.KeepAspectRatio,
                                                 Qt.SmoothTransformation))
        av.setFixedSize(32, 32)
        head.addWidget(av)
        color = self.SENDER_COLORS[sum(name.encode("utf-8")) % len(self.SENDER_COLORS)]
        lbl_name = QLabel(name)
        lbl_name.setStyleSheet("font-weight:bold;color:%s;font-size:20px;" % color)
        lbl_meta = QLabel(" #%s  %s" % (mid, time_str))
        lbl_meta.setStyleSheet("color:#8a929c;font-size:15px;")
        head.addWidget(lbl_name)
        head.addStretch(1)
        head.addWidget(lbl_meta)
        outer.addLayout(head)
        lbl_txt = QLabel(content)
        lbl_txt.setWordWrap(True)
        lbl_txt.setStyleSheet("font-size:18px;")
        lbl_txt.setTextInteractionFlags(Qt.TextSelectableByMouse)
        outer.addWidget(lbl_txt)
        if read_by:
            lbl_read = QLabel("已读: " + ", ".join(read_by))
            lbl_read.setStyleSheet("color:#a0a8b3;font-size:14px;")
            outer.addWidget(lbl_read)


class CollapsibleBox(QWidget):
    """可折叠面板：标题按钮 + 内容区，点击标题展开/折叠（对齐网页版）"""

    def __init__(self, title, parent=None):
        super().__init__(parent)
        self.toggle_btn = QToolButton()
        self.toggle_btn.setText(title)
        self.toggle_btn.setCheckable(True)
        self.toggle_btn.setChecked(True)
        self.toggle_btn.setToolButtonStyle(Qt.ToolButtonTextBesideIcon)
        self.toggle_btn.setArrowType(Qt.DownArrow)
        self.toggle_btn.setStyleSheet(
            "QToolButton{border:none;font-weight:bold;font-size:17px;color:#3a5a8c;padding:2px;}")
        self.content = QWidget()
        self.content_lay = QVBoxLayout(self.content)
        self.content_lay.setContentsMargins(0, 4, 0, 0)
        self.content_lay.setSpacing(6)
        outer = QVBoxLayout(self)
        outer.setContentsMargins(0, 0, 0, 0)
        outer.addWidget(self.toggle_btn)
        outer.addWidget(self.content)
        self.toggle_btn.toggled.connect(self._on_toggle)

    def _on_toggle(self, checked):
        self.content.setVisible(checked)
        self.toggle_btn.setArrowType(Qt.DownArrow if checked else Qt.RightArrow)


class KotatsuPage(QWidget):
    def __init__(self, parent=None):
        super().__init__(parent)
        self._last_mid = 0
        self._build()
        self._timer = QTimer(self)
        self._timer.timeout.connect(self.poll)
        self._timer.start(3000)
        self.refresh_rooms()

    def _build(self):
        root = QVBoxLayout(self)
        root.setContentsMargins(12, 12, 12, 12)
        root.setSpacing(10)

        header = QGroupBox("被炉房间")
        h = QHBoxLayout(header)
        h.addWidget(QLabel("选择房间"))
        self.room_box = QComboBox()
        self.room_box.currentIndexChanged.connect(self.refresh_room)
        h.addWidget(self.room_box, 3)
        self.btn_refresh = QPushButton("刷新")
        set_btn_icon(self.btn_refresh, "btn_refresh.png")
        self.btn_refresh.clicked.connect(self.refresh_room)
        h.addWidget(self.btn_refresh)
        self.lbl_status = QLabel("在线: -")
        self.lbl_status.setStyleSheet("color:#2e7d32;font-weight:bold;")
        h.addWidget(self.lbl_status)
        root.addWidget(header)

        split = QSplitter(Qt.Horizontal)

        chat_box = QGroupBox("聊天区")
        cl = QVBoxLayout(chat_box)
        self.chat_scroll = QScrollArea()
        self.chat_scroll.setWidgetResizable(True)
        self.chat_scroll.setStyleSheet("QScrollArea{background:#f2f5f9;border:1px solid #e3e6ea;border-radius:8px;}")
        self.chat_wrap = QWidget()
        self.chat_lay = QVBoxLayout(self.chat_wrap)
        self.chat_lay.setContentsMargins(8, 8, 8, 8)
        self.chat_lay.setSpacing(6)
        self.chat_lay.addStretch(1)
        self.chat_scroll.setWidget(self.chat_wrap)
        cl.addWidget(self.chat_scroll)

        inp = QHBoxLayout()
        self.msg_edit = QPlainTextEdit()
        self.msg_edit.setPlaceholderText("输入消息，回车发送，Shift+回车换行")
        self.msg_edit.setFixedHeight(130)
        self.msg_edit.setStyleSheet("font-size:17px;")
        self.msg_edit.installEventFilter(self)
        inp.addWidget(self.msg_edit, 3)
        self.btn_send = QPushButton("发送")
        set_btn_icon(self.btn_send, "btn_send.png", 20)
        self.btn_send.clicked.connect(self.send_msg)
        self.btn_send.setFixedSize(100, 44)
        inp.addWidget(self.btn_send)
        cl.addLayout(inp)
        split.addWidget(chat_box)

        right = QWidget()
        rl = QVBoxLayout(right)
        todo_box = CollapsibleBox("处理事项")
        self.todo_pending = QListWidget()
        self.todo_pending.setWordWrap(True)
        self.todo_pending.setStyleSheet("font-size:16px;")
        self.todo_pending.setItemDelegate(WrapItemDelegate())
        self.todo_pending.setMinimumHeight(220)
        todo_box.content_lay.addWidget(self.todo_pending)
        tb = QHBoxLayout()
        self.btn_done = QPushButton("已办结")
        set_btn_icon(self.btn_done, "btn_done.png")
        self.btn_reject = QPushButton("拒绝")
        set_btn_icon(self.btn_reject, "btn_reject.png")
        self.btn_done.clicked.connect(lambda: self._todo_action("done"))
        self.btn_reject.clicked.connect(lambda: self._todo_action("rejected"))
        tb.addWidget(self.btn_done)
        tb.addWidget(self.btn_reject)
        todo_box.content_lay.addLayout(tb)
        rl.addWidget(todo_box)

        self.handled_box = CollapsibleBox("已处理 (0)")
        self.todo_done = QListWidget()
        self.todo_done.setWordWrap(True)
        self.todo_done.setStyleSheet("font-size:15px;")
        self.todo_done.setItemDelegate(WrapItemDelegate())
        self.todo_done.setMinimumHeight(140)
        self.handled_box.content_lay.addWidget(self.todo_done)
        self.handled_box.toggle_btn.setChecked(False)  # 默认折叠已处理
        rl.addWidget(self.handled_box)

        search_box = CollapsibleBox("检索记录")
        self.s_id = QLineEdit(); self.s_id.setPlaceholderText("消息ID")
        self.s_user = QLineEdit(); self.s_user.setPlaceholderText("用户名")
        self.s_from = QLineEdit(); self.s_from.setPlaceholderText("起始时间(YYYY-MM-DD)")
        self.s_to = QLineEdit(); self.s_to.setPlaceholderText("结束时间(YYYY-MM-DD)")
        for w in (self.s_id, self.s_user, self.s_from, self.s_to):
            search_box.content_lay.addWidget(w)
        sb = QHBoxLayout()
        self.btn_search = QPushButton("检索")
        set_btn_icon(self.btn_search, "btn_search.png")
        self.btn_clear = QPushButton("清除")
        set_btn_icon(self.btn_clear, "btn_clear.png")
        self.btn_search.clicked.connect(self.do_search)
        self.btn_clear.clicked.connect(self.clear_search)
        sb.addWidget(self.btn_search)
        sb.addWidget(self.btn_clear)
        search_box.content_lay.addLayout(sb)
        self.search_out = QListWidget()
        self.search_out.setWordWrap(True)
        self.search_out.setStyleSheet("font-size:16px;")
        self.search_out.setItemDelegate(WrapItemDelegate())
        self.search_out.setMinimumHeight(180)
        search_box.content_lay.addWidget(self.search_out)
        rl.addWidget(search_box)
        rl.addStretch(1)
        split.addWidget(right)
        split.setSizes([900, 330])
        root.addWidget(split, 1)

        self.lbl_members = QLabel("成员: -")
        self.lbl_members.setStyleSheet("color:#5a6572;")
        root.addWidget(self.lbl_members)

    def _room_file(self):
        return REGISTRY / "kotatsu_rooms" / f"{self.room_box.currentText()}.json"

    def _room_data(self):
        room = self.room_box.currentText()
        if not room:
            return {}
        return memory_db.get_doc("kotatsu_room:" + room, {})

    def refresh_rooms(self):
        cur = self.room_box.currentText()
        self.room_box.blockSignals(True)
        self.room_box.clear()
        rooms = [k.split(":", 1)[1] for k in memory_db.keys_with_prefix("kotatsu_room:")]
        self.room_box.addItems(sorted(rooms))
        if cur and cur in rooms:
            self.room_box.setCurrentText(cur)
        self.room_box.blockSignals(False)
        self.refresh_room()

    def refresh_room(self):
        try:
            d = self._room_data()
            self._last_mid = 0
            self._render_messages(d)
            self._render_todos(d)
            self._render_members(d)
        except Exception as e:
            print("[kotatsu] refresh_room error:", e, file=sys.stderr)

    def poll(self):
        try:
            self._poll_impl()
        except Exception as e:
            print("[kotatsu] poll error:", e, file=sys.stderr)

    def _poll_impl(self):
        d = self._room_data()
        if not d:
            return
        # 管理员在线心跳：面板打开时每20秒标记一次 last_active（锁事务写）
        now = datetime.now()
        la = d.get("last_active", {})
        la = la if isinstance(la, dict) else {}
        try:
            old = datetime.strptime(str(la.get("管理员", ""))[:19],
                                    "%Y-%m-%d %H:%M:%S") if la.get("管理员") else None
        except Exception:
            old = None
        if old is None or (now - old).total_seconds() >= 20:
            ts = now.strftime("%Y-%m-%d %H:%M:%S")

            def hb(rd):
                la = rd.get("last_active")
                if not isinstance(la, dict):
                    rd["last_active"] = {}
                rd["last_active"]["管理员"] = ts

            self._mutate_room(hb)
            d = self._room_data()
        msgs = safe_list(d.get("messages", []))
        if msgs and safe_int(msgs[-1].get("id")) != self._last_mid:
            self._render_messages(d, follow_bottom=False)  # 新消息不强制跳底，保持在原位
        self._render_members(d)
        self._render_todos(d)

    def _render_messages(self, d, follow_bottom=True):
        msgs = safe_list(d.get("messages", []))[-80:]
        sb = self.chat_scroll.verticalScrollBar()
        was_at_bottom = (sb.maximum() - sb.value()) < 50
        saved_value = sb.value()
        anchor_id, anchor_off = None, 0
        if not (follow_bottom or was_at_bottom):
            top_y = saved_value
            for i in range(self.chat_lay.count() - 1):
                w = self.chat_lay.itemAt(i).widget() if self.chat_lay.itemAt(i) else None
                if w is not None and w.y() + w.height() > top_y:
                    anchor_id = getattr(w, "msg_id", None)
                    anchor_off = max(0, top_y - w.y())
                    break
        while self.chat_lay.count() > 1:
            item = self.chat_lay.takeAt(0)
            w = item.widget()
            if w is not None:
                w.deleteLater()
        for m in msgs:
            sender = str(m.get("from") or m.get("user") or "?")
            rb = m.get("read_by")
            if not isinstance(rb, (list, tuple)):
                rb = ()
            else:
                rb = [str(x) for x in rb]
            self.chat_lay.insertWidget(self.chat_lay.count() - 1, MessageBubble(
                sender, m.get("id", "?"), str(m.get("time", "")),
                str(m.get("content", "")), rb))
        self._last_mid = safe_int(msgs[-1].get("id")) if msgs else 0
        if follow_bottom or was_at_bottom:
            sb.setValue(sb.maximum())
        elif anchor_id is not None:
            restored = False
            for i in range(self.chat_lay.count() - 1):
                w = self.chat_lay.itemAt(i).widget() if self.chat_lay.itemAt(i) else None
                if w is not None and getattr(w, "msg_id", None) == anchor_id:
                    sb.setValue(max(0, w.y() + anchor_off))
                    restored = True
                    break
            if not restored:
                sb.setValue(min(saved_value, sb.maximum()))

    def _render_todos(self, d):
        todos = safe_list(d.get("todos", []))
        pending = [t for t in todos if t.get("status", "pending") == "pending"]
        done = [t for t in todos if t.get("status", "pending") != "pending"]
        self.todo_pending.clear()
        for t in pending[-60:]:
            self.todo_pending.addItem("#%s %s：%s" % (
                t.get("id", "?"), t.get("from", t.get("user", "?")),
                str(t.get("content", ""))))
        self.todo_done.clear()
        for t in done[-80:]:
            st = t.get("status", "")
            mark = {"done": "[已办结]", "rejected": "[已拒绝]",
                    "withdrawn": "[已撤回]"}.get(st, "[" + st + "]")
            self.todo_done.addItem("%s #%s %s：%s" % (
                mark, t.get("id", "?"), t.get("from", t.get("user", "?")),
                str(t.get("content", ""))[:150]))
        self.handled_box.toggle_btn.setText("已处理 (%d)" % len(done))

    def _render_members(self, d):
        la = d.get("last_active", {})
        la = la if isinstance(la, dict) else {}
        now = datetime.now()
        online = []
        for k, v in la.items():
            try:
                t = datetime.strptime(str(v)[:19], "%Y-%m-%d %H:%M:%S")
            except Exception:
                t = None
            if t and (now - t).total_seconds() < 70:
                online.append(k)
        online_set = set(online)
        members = [m for m in d.get("members", []) if isinstance(m, str)]
        if members:
            parts = []
            for m in members:
                if m in online_set:
                    parts.append('<b><span style="color:#2e7d32;">%s（在线）</span></b>' % m)
                else:
                    parts.append(m)
            self.lbl_members.setText("成员: " + "、".join(parts))
            self.lbl_members.setTextFormat(Qt.RichText)
        else:
            self.lbl_members.setText("成员: -")
        if online:
            self.lbl_status.setText("在线: %d（%s）" % (len(online), "、".join(online)))
        else:
            self.lbl_status.setText("在线: 0")

    def _save(self, d):
        memory_db.set_doc("kotatsu_room:" + self.room_box.currentText(), d)

    def _mutate_room(self, mutator):
        """加文件锁事务化更新房间：锁内重读→mutator(d)→原子写→解锁（防并发丢更新）"""
        import msvcrt
        room = self.room_box.currentText()
        f = self._room_file()
        lock_path = f.with_suffix(".json.lock")
        deadline = time.time() + 10
        lf = None
        while True:
            try:
                lf = open(lock_path, "a+b")
                lf.seek(0)
                if lf.read(1) == b"": 
                    lf.write(b"0")
                    lf.flush()
                lf.seek(0)
                msvcrt.locking(lf.fileno(), msvcrt.LK_NBLCK, 1)
                break
            except OSError:
                if lf is not None:
                    try:
                        lf.close()
                    except OSError:
                        pass
                if time.time() > deadline:
                    return False
                time.sleep(0.05)
        try:
            d = memory_db.get_doc("kotatsu_room:" + room, {})  # 从DB读，禁止再从遗留JSON文件读（否则会覆盖清空历史）
            mutator(d)
            self._save(d)
        finally:
            try:
                lf.seek(0)
                msvcrt.locking(lf.fileno(), msvcrt.LK_UNLCK, 1)
            except OSError:
                pass
            try:
                lf.close()
            except OSError:
                pass
        return True

    def send_msg(self):
        try:
            self._send_msg_impl()
        except Exception as e:
            print("[kotatsu] send_msg error:", e, file=sys.stderr)

    def _send_msg_impl(self):
        content = self.msg_edit.toPlainText().strip()
        if not content or not self.room_box.currentText():
            return

        def m(d):
            nid = safe_int(d.get("next_id"), 1)
            d.setdefault("messages", []).append({
                "id": nid, "time": datetime.now().strftime("%Y-%m-%d %H:%M"),
                "from": "管理员", "content": content, "read_by": []})
            d["next_id"] = nid + 1

        self._mutate_room(m)
        self.msg_edit.clear()
        self._render_messages(self._room_data())

    def _todo_action(self, status):
        try:
            self._todo_action_impl(status)
        except Exception as e:
            print("[kotatsu] todo_action error:", e, file=sys.stderr)

    def _todo_action_impl(self, status):
        row = self.todo_pending.currentRow()
        if row < 0:
            return

        def m(d):
            todos = safe_list(d.get("todos", []))
            pending = [t for t in todos if t.get("status", "pending") == "pending"]
            if row < len(pending):
                t = pending[row]
                for x in todos:
                    if x.get("id") == t.get("id"):
                        x["status"] = status

        self._mutate_room(m)
        self._render_todos(self._room_data())

    def do_search(self):
        try:
            self._do_search_impl()
        except Exception as e:
            print("[kotatsu] search error:", e, file=sys.stderr)

    def _do_search_impl(self):
        msgs = safe_list(self._room_data().get("messages", []))
        qid = self.s_id.text().strip()
        quser = self.s_user.text().strip()
        qfrom = self.s_from.text().strip()
        qto = self.s_to.text().strip()
        out = []
        for m in msgs:
            if qid and str(m.get("id", "")) != qid:
                continue
            if quser and quser not in str(m.get("user", "")):
                continue
            t = str(m.get("time", ""))
            if qfrom and t < qfrom:
                continue
            if qto and t[:10] > qto:
                continue
            out.append(m)
        self.search_out.clear()
        for m in out[-100:]:
            self.search_out.addItem("#%s %s %s: %s" % (
                m.get("id", "?"), m.get("time", ""), m.get("user", "?"),
                str(m.get("content", ""))[:120]))

    def clear_search(self):
        for w in (self.s_id, self.s_user, self.s_from, self.s_to):
            w.clear()
        self.search_out.clear()

    def eventFilter(self, obj, ev):
        if obj is self.msg_edit and ev.type() == QEvent.KeyPress:
            if ev.key() in (Qt.Key_Return, Qt.Key_Enter) and not (ev.modifiers() & Qt.ShiftModifier):
                self.send_msg()
                return True
        return super().eventFilter(obj, ev)


class SkillsPage(QWidget):
    def __init__(self, parent=None):
        super().__init__(parent)
        self._build()
        self.refresh()

    def _build(self):
        lay = QVBoxLayout(self)
        split = QSplitter(Qt.Horizontal)

        left = QGroupBox("全部技能")
        ll = QVBoxLayout(left)
        self.skill_list = QListWidget()
        self.skill_list.setWordWrap(True)
        self.skill_list.setItemDelegate(WrapItemDelegate())
        self.skill_list.itemClicked.connect(self.show_skill_intro)
        ll.addWidget(self.skill_list)
        split.addWidget(left)

        right = QGroupBox("各用户装载的技能")
        rl = QVBoxLayout(right)
        self.table = QTableWidget(0, 3)
        self.table.setHorizontalHeaderLabels(["用户", "最后同步", "已装载技能"])
        self.table.setWordWrap(True)
        self.table.setEditTriggers(QAbstractItemView.NoEditTriggers)
        self.table.setSelectionBehavior(QTableWidget.SelectRows)
        self.table.verticalHeader().setSectionResizeMode(QHeaderView.ResizeToContents)
        self.table.horizontalHeader().setSectionResizeMode(QHeaderView.Stretch)
        self.table.cellClicked.connect(self.on_table_click)
        rl.addWidget(self.table)
        split.addWidget(right)

        split.setSizes([320, 780])
        lay.addWidget(split)

        self.intro_box = QTextEdit()
        self.intro_box.setReadOnly(True)
        self.intro_box.setPlaceholderText("点击左侧技能名称，或表格中「已装载技能」里的技能，查看简介")
        self.intro_box.setMinimumHeight(80)
        self.intro_box.setMaximumHeight(130)
        lay.addWidget(self.intro_box)

        self.btn_refresh = QPushButton("刷新")
        set_btn_icon(self.btn_refresh, "btn_refresh.png")
        self.btn_refresh.clicked.connect(self.refresh)
        lay.addWidget(self.btn_refresh)

    def show_skill_intro(self, item):
        folder = item.text()
        self.intro_box.setPlainText(read_skill_intro(folder))

    def on_table_click(self, row, col):
        if col != 2:
            return
        cell = self.table.item(row, col)
        if cell is None:
            return
        skills = [s.strip() for s in cell.text().split(",") if s.strip()]
        parts = []
        for s in skills:
            if (SKILLS_DIR / s / "SKILL.md").exists():
                parts.append(read_skill_intro(s))
        if parts:
            self.intro_box.setPlainText("\n\n".join(parts))
        else:
            self.intro_box.setPlainText("（未找到对应技能的 SKILL.md）")

    def refresh(self):
        self.skill_list.clear()
        for d in sorted(SKILLS_DIR.iterdir()):
            if d.is_dir() and (d / "SKILL.md").exists():
                self.skill_list.addItem(d.name)
        agents = {}
        for k in memory_db.keys_with_prefix("agent_versions:"):
            try:
                d = memory_db.get_doc(k, {})
                agents[k.split(":", 1)[1]] = (d.get("updated_at", ""),
                                              sorted(d.get("skills", {}).keys()))
            except Exception:
                pass
        self.table.setRowCount(len(agents))
        for r, (a, (t, skills)) in enumerate(sorted(agents.items())):
            self.table.setItem(r, 0, QTableWidgetItem(a))
            self.table.setItem(r, 1, QTableWidgetItem(t))
            self.table.setItem(r, 2, QTableWidgetItem(", ".join(skills)))


# ---------- 主窗口 ----------

class MainWindow(QMainWindow):
    def __init__(self):
        super().__init__()
        self.setWindowTitle("流变系统管理面板")
        self.setWindowIcon(QIcon(str(ICON_DIR / "app.png")))
        self.resize(1200, 760)

        central = QWidget()
        lay = QHBoxLayout(central)
        lay.setContentsMargins(0, 0, 0, 0)
        lay.setSpacing(0)

        self.menu = QListWidget()
        for text, icon in [("系统用户管理", "menu_users.png"),
                            ("被炉系统", "menu_kotatsu.png"),
                            ("Skill 管理", "menu_skills.png")]:
            item = QListWidgetItem(QIcon(str(ICON_DIR / icon)), text)
            item.setSizeHint(QSize(0, 48))
            self.menu.addItem(item)
        self.menu.setIconSize(QSize(26, 26))
        self.menu.setFixedWidth(190)
        lay.addWidget(self.menu)

        self.stack = QStackedWidget()
        self.users_page = UsersPage()
        self.kotatsu_page = KotatsuPage()
        self.skills_page = SkillsPage()
        self.stack.addWidget(self.users_page)
        self.stack.addWidget(self.kotatsu_page)
        self.stack.addWidget(self.skills_page)
        lay.addWidget(self.stack, 1)

        self.setCentralWidget(central)
        self.menu.currentRowChanged.connect(self.stack.setCurrentIndex)
        self.menu.setCurrentRow(0)


def main():
    import multiprocessing
    multiprocessing.freeze_support()  # PyInstaller 打包后多进程密码找回必需
    app = QApplication(sys.argv)
    app.setStyleSheet(STYLE)
    w = MainWindow()
    w.show()
    sys.exit(app.exec_())


if __name__ == "__main__":
    main()
