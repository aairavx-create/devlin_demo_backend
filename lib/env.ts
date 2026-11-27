function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable ${name}. Copy .env.example to .env.local and fill it in.`);
  return value;
}

export const env = {
  get databaseUrl() {
    return required('DATABASE_URL');
  },
  get appId() {
    return required('META_APP_ID');
  },
  get appSecret() {
    return required('META_APP_SECRET');
  },
  get graphVersion() {
    return process.env.META_GRAPH_VERSION || 'v23.0';
  },
  get redirectUri() {
    return required('META_REDIRECT_URI');
  },
  get loginConfigId() {
    return process.env.META_LOGIN_CONFIG_ID || '';
  },
  get scopes() {
    return (process.env.META_SCOPES || '').split(',').map((s) => s.trim()).filter(Boolean);
  },
  get webhookVerifyToken() {
    return required('META_WEBHOOK_VERIFY_TOKEN');
  },
  get encryptionKey() {
    return required('TOKEN_ENCRYPTION_KEY');
  },
  get dashboardUrl() {
    return process.env.DASHBOARD_URL || 'http://localhost:5173';
  },
};
