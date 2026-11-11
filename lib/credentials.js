/**
 * 凭证读取：只经 DSH 的 credentials 服务（内存），不读文件、不写日志、不返回完整值以外的任何东西。
 */
export async function credentialValue(credentials, ref) {
  if (!ref) return '';
  try {
    const hit = await credentials?.resolve?.(ref);
    const value = hit?.value ?? hit;
    if (typeof value === 'string' && value.length > 0) return value;
  } catch { /* 服务未就绪或未配置 */ }
  // 兜底只看进程环境（DSH 自己也是这么取 apiKeyEnv 的）；不落盘
  const fromEnv = process.env?.[ref];
  return typeof fromEnv === 'string' && fromEnv.length > 0 ? fromEnv : '';
}
