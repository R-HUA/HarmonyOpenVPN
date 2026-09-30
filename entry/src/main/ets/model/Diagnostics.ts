export class LogRedactor {
  private insidePem: boolean = false;
  constructor(private secrets: string[]) {}
  clean(text: string): string {
    const lines: string[] = [];
    for (const line of text.split('\n')) {
      if (/-----BEGIN|<(key|cert|ca|tls-auth|tls-crypt|auth-user-pass)>/i.test(line)) this.insidePem = true;
      if (this.insidePem) {
        if (/-----END|<\/(key|cert|ca|tls-auth|tls-crypt|auth-user-pass)>/i.test(line)) this.insidePem = false;
        lines.push('[certificate/key material omitted]'); continue;
      }
      if (/password|passwd|username|auth-token|session[_ -]?id|bearer |CRV1:|SCRV1:|private.?key.?pass/i.test(line)) {
        lines.push('[authentication detail omitted]'); continue;
      }
      let safe = line;
      for (const secret of this.secrets) {
        if (secret.length > 0) safe = safe.split(secret).join('[redacted]');
      }
      lines.push(safe);
    }
    return lines.join('\n').slice(0, 8192);
  }
}
interface CodedError extends Error { code?: number }
export function errorText(error: Error): string {
  const detail = error.message || JSON.stringify(error);
  const code = (error as CodedError).code;
  return (code === undefined ? '' : '[' + code + '] ') +
    (detail && detail !== '{}' ? detail : '未知错误，请查看连接日志');
}
