export interface DrawerItem {
  id: string;
  title: string;
  year?: number | string;
  kind: string;
  artClass?: string;
  status?: string;
  description?: string;
  meta?: string;
  connectionId?: number;                 // which connection the API actions target
  params?: Record<string, unknown>;      // extra params handlers need (movieId, seriesId, hash, requestId…)
}
