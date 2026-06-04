import { json } from '../../_shared/responses';

export const onRequestGet: PagesFunction = async () => {
  return json(200, { ok: true });
};
