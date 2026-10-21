import { createEffect, createResource, createRoot, createSignal } from 'solid-js';
import { api } from './api';

export const { me, guide, afterLogin, inWatchLater, toggleWatchLater, watchLaterCount } = createRoot(() => {
  const [me, { refetch: refetchMe }] = createResource(api.me);
  const [guide, { refetch: refetchGuide }] = createResource(() => me()?.loggedIn, api.guide);

  // Watch Later membership, shared by every button on the page.
  const [wl, setWl] = createSignal<Set<string>>(new Set());
  createEffect(() => {
    if (me()?.loggedIn) api.watchLaterIds().then((ids) => setWl(new Set(ids)), () => {});
  });
  const inWatchLater = (id: string) => wl().has(id);
  const toggleWatchLater = async (id: string) => {
    const on = !wl().has(id);
    const apply = (v: boolean) =>
      setWl((s) => {
        const n = new Set(s);
        if (v) n.add(id);
        else n.delete(id);
        return n;
      });
    apply(on); // optimistic
    try {
      await api.setWatchLater(id, on);
    } catch {
      apply(!on);
    }
    return on;
  };

  return {
    me,
    guide,
    afterLogin: () => {
      refetchMe();
      refetchGuide();
    },
    inWatchLater,
    toggleWatchLater,
    watchLaterCount: () => wl().size,
  };
});
