// Platform-independent import policy; exercised on the desktop before HAP compilation.
export interface ProfileAsset { name: string; text: string }
const MAX_PROFILE = 1024 * 1024;

export function safeProfileName(name: string): string {
  if (!name || name === '.' || name === '..' || /[\\/\x00-\x1f]/.test(name)) {
    throw new Error('无效文件名');
  }
  return name;
}

export function optionTokens(line: string): string[] {
  const tokens: string[] = [];
  let token = '';
  let quote = '';
  let escaped = false;
  let active = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (escaped) { token += c; escaped = false; active = true; continue; }
    if (c === '\\') { escaped = true; active = true; continue; }
    if (quote) { if (c === quote) quote = ''; else token += c; continue; }
    if (c === '"' || c === "'") { quote = c; active = true; continue; }
    if (!active && (c === '#' || c === ';')) break;
    if (/\s/.test(c)) {
      if (active) { tokens.push(token); token = ''; active = false; }
    } else { token += c; active = true; }
  }
  if (quote || escaped) throw new Error('配置包含未闭合引号或转义');
  if (active) tokens.push(token);
  return tokens;
}

export function inlineProfile(content: string, assets: ProfileAsset[]): string {
  if (content.length > MAX_PROFILE || content.indexOf('\0') >= 0) throw new Error('配置过大或包含二进制内容');
  const result: string[] = [];
  const lines = content.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').split('\n');
  const fileOptions = ['ca', 'cert', 'key', 'tls-auth', 'tls-crypt', 'tls-crypt-v2', 'extra-certs'];
  let block = '';
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (block) {
      if (trimmed === '</' + block + '>') block = '';
      result.push(line);
      continue;
    }
    if (/^<[^/][^>]*>$/.test(trimmed) && trimmed !== '<connection>') {
      block = trimmed.slice(1, -1);
      if (block === 'auth-user-pass') throw new Error('不保存内嵌账号密码，请改用 auth-user-pass 并在连接时输入');
      result.push(line); continue;
    }
    const tokens = optionTokens(line);
    if (tokens.length === 0) { result.push(line); continue; }
    const directive = tokens[0].replace(/^--/, '');
    if (directive === 'auth-user-pass') { result.push('auth-user-pass'); continue; }
    if (fileOptions.indexOf(directive) >= 0 && tokens.length > 1 && tokens[1] !== '[inline]') {
      const name = safeProfileName(tokens[1]);
      const found = assets.filter((asset: ProfileAsset) => asset.name === name);
      if (found.length !== 1) throw new Error('请同时选择唯一的证书/密钥文件：' + name);
      const text = found[0].text.trim();
      if (!text || text.length > MAX_PROFILE || text.indexOf('\0') >= 0 || /<\//.test(text)) {
        throw new Error('证书或密钥文件内容无效：' + name);
      }
      if (tokens.length > 2) {
        if (directive !== 'tls-auth' || tokens.length !== 3 || !/^[01]$/.test(tokens[2])) {
          throw new Error('文件指令参数不受支持：' + directive);
        }
        result.push('key-direction ' + tokens[2]);
      }
      result.push('<' + directive + '>\n' + text + '\n</' + directive + '>');
    } else result.push(line);
  }
  if (block) throw new Error('配置缺少结束标签：' + block);
  const output = result.join('\n');
  if (output.length > MAX_PROFILE) throw new Error('合并后的配置超过 1 MB');
  return output;
}
