/** kit 自身版本（协议 §19：kit 版本必须出现在服务挂载行——版本漂移可观测）。
 *  ⚠ 与 package.json 的 version **双处同步**——改这里必须改那份，反之亦然。
 *  独立成文件防"两处真相"：index 与 base-liubian-service 都从这里取。 */
export const KIT_VERSION = '0.2.0'
