import api from './api';
import type { ApiResponse, CsesOverview } from '../types';

export const csesApi = {
  async getOverview(): Promise<CsesOverview> {
    const res = await api.get<ApiResponse<CsesOverview>>('/cses');
    return res.data.data;
  },
  async setEnabled(enabled: boolean): Promise<CsesOverview> {
    const res = await api.patch<ApiResponse<CsesOverview>>('/cses/settings', { enabled });
    return res.data.data;
  },
  async selectTopic(topicId: string): Promise<CsesOverview> {
    const res = await api.post<ApiResponse<CsesOverview>>('/cses/topic', { topicId });
    return res.data.data;
  },
  async restart(topicId: string): Promise<CsesOverview> {
    const res = await api.post<ApiResponse<CsesOverview>>(`/cses/topics/${topicId}/restart`);
    return res.data.data;
  },
  async skip(taskId: string): Promise<CsesOverview> {
    const res = await api.post<ApiResponse<CsesOverview>>(`/cses/problems/${taskId}/skip`);
    return res.data.data;
  },
  async retry(taskId: string): Promise<CsesOverview> {
    const res = await api.post<ApiResponse<CsesOverview>>(`/cses/problems/${taskId}/retry`);
    return res.data.data;
  },
  async acknowledgeReturn(): Promise<CsesOverview> {
    const res = await api.post<ApiResponse<CsesOverview>>('/cses/return-ack');
    return res.data.data;
  },
};
