const privateValues = new Set<string>();
export function registerSecret(value: string) { if (value) privateValues.add(value); }
// Used at both log and Discord error boundaries. Never serialize error objects or
// provider responses to the browser. Configured credentials are redacted exactly.
export function redact(value: string): string {
  let result = value.replace(/https?:\/\/[^\s<>"'`]+/gi, '[URL redacted]')
    .replace(/((?:authorization|x-emby-token|x-mediabrowser-token|api_key|access_token|playsessionid)\s*[:=]\s*)[^\r\n,]+/gi, '$1[redacted]');
  for (const [name, secret] of Object.entries(process.env)) {
    if (/(?:TOKEN|PASSWORD|SECRET|API_KEY|CREDENTIAL)/i.test(name) && secret && secret.length >= 4) result = result.split(secret).join('[redacted]');
  }
  for (const secret of privateValues) result = result.split(secret).join('[redacted]');
  return result;
}
