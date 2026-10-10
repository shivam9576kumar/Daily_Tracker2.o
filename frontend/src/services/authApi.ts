import api from './api';

function getApiBase(): string {
  const envUrl = import.meta.env.VITE_API_URL;
  if (typeof window !== 'undefined' && window.location.hostname !== 'localhost' && window.location.hostname !== '127.0.0.1') {
    if (!envUrl || envUrl.includes('localhost') || envUrl.includes('127.0.0.1')) {
      return '/api';
    }
  }
  return envUrl || '/api';
}

const API_BASE = getApiBase();

export const authApi = {
  /** Get Google OAuth login URL */
  getGoogleLoginUrl() {
    return `${API_BASE}/auth/google`;
  },

  /** 1-Click Demo / Guest login */
  async demoLogin() {
    const res = await api.post('/auth/demo');
    return res.data.data;
  },

  /** Get current user profile */
  async getMe() {
    const res = await api.get('/auth/me');
    return res.data.data;
  },

  /** Logout */
  async logout() {
    await api.post('/auth/logout');
  },

  /** Exchange short-lived OAuth code for JWT */
  async exchangeCode(code: string): Promise<{ token: string }> {
    const res = await api.post('/auth/exchange', { code });
    return res.data.data;
  },
};
