import { createResource, createRoot } from 'solid-js';
import { api } from './api';

export const { me, library, afterLogin, refreshLibrary } = createRoot(() => {
  const [me, { refetch: refetchMe }] = createResource(api.me);
  const [library, { refetch: refetchLibrary }] = createResource(() => me()?.loggedIn, api.library);
  return {
    me,
    library,
    refreshLibrary: () => refetchLibrary(),
    afterLogin: () => {
      refetchMe();
      refetchLibrary();
    },
  };
});
