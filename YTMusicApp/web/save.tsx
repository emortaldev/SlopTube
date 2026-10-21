import { createEffect, createRoot, createSignal, For, onCleanup, onMount, Show } from 'solid-js';
import { api, forgetCollection, thumb, type Rating, type SaveTarget } from './api';
import { Icon } from './icons';
import { player } from './player';
import { me } from './state';

// ---------- ratings ----------

const { ratingOf, rate } = createRoot(() => {
  const [ratings, setRatings] = createSignal(new Map<string, Rating>());
  const put = (id: string, r: Rating) => setRatings((m) => new Map(m).set(id, r));

  // Fetch the current song's rating once; cached for the session.
  createEffect(() => {
    const id = player.current()?.id;
    if (!id || !me()?.loggedIn || ratings().has(id)) return;
    api.rating(id).then((r) => !ratings().has(id) && put(id, r), () => {});
  });

  const rate = async (id: string, r: Rating) => {
    const prev = ratings().get(id) ?? 'INDIFFERENT';
    put(id, r); // optimistic
    try {
      await api.rate(id, r);
      forgetCollection('LM');
    } catch (e) {
      put(id, prev);
      toast((e as Error).message);
    }
  };
  return { ratingOf: (id: string) => ratings().get(id) ?? 'INDIFFERENT', rate };
});

/** Thumbs down / thumbs up toggles, as in the YouTube Music player bar. */
export function LikeButtons(p: { id: string }) {
  const r = () => ratingOf(p.id);
  return (
    <Show when={me()?.loggedIn}>
      <button
        class="ibtn"
        classList={{ on: r() === 'DISLIKE' }}
        aria-label="Dislike"
        aria-pressed={r() === 'DISLIKE'}
        onClick={() => rate(p.id, r() === 'DISLIKE' ? 'INDIFFERENT' : 'DISLIKE')}
      >
        <Icon name={r() === 'DISLIKE' ? 'dislike' : 'dislikeOutline'} size={22} />
      </button>
      <button
        class="ibtn"
        classList={{ on: r() === 'LIKE' }}
        aria-label="Like"
        aria-pressed={r() === 'LIKE'}
        onClick={() => {
          const on = r() !== 'LIKE';
          rate(p.id, on ? 'LIKE' : 'INDIFFERENT');
          if (on) toast('Saved to Liked Music');
        }}
      >
        <Icon name={r() === 'LIKE' ? 'like' : 'likeOutline'} size={22} />
      </button>
    </Show>
  );
}

// ---------- toast ----------

const [toastText, setToastText] = createSignal('');
let toastTimer = 0;
export function toast(text: string) {
  setToastText(text);
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => setToastText(''), 2500);
}

// ---------- save to playlist ----------

const [saving, setSaving] = createSignal<{ id: string; x: number; y: number } | null>(null);

/** Open the "Save to playlist" popover for `id`, anchored to the clicked element. */
export function openSave(id: string, anchor: HTMLElement) {
  const r = anchor.getBoundingClientRect();
  setSaving({ id, x: r.left + r.width / 2, y: r.top });
}

export function SaveButton(p: { id: string; size?: number; class?: string }) {
  return (
    <Show when={me()?.loggedIn}>
      <button
        class={p.class ?? 'ibtn'}
        aria-label="Save to playlist"
        title="Save to playlist"
        onClick={(e) => {
          e.stopPropagation();
          openSave(p.id, e.currentTarget);
        }}
      >
        <Icon name="playlistAdd" size={p.size ?? 22} />
      </button>
    </Show>
  );
}

const W = 300;

function SaveMenu(p: { id: string; x: number; y: number }) {
  let el!: HTMLDivElement;
  const [targets, setTargets] = createSignal<SaveTarget[]>();
  const [error, setError] = createSignal('');
  const [creating, setCreating] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  api.saveTargets(p.id).then(setTargets, (e) => setError(e.message));

  const close = () => setSaving(null);
  onMount(() => {
    const onDown = (e: PointerEvent) => !el.contains(e.target as Node) && close();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close();
    // Defer so the click that opened the menu doesn't close it.
    setTimeout(() => document.addEventListener('pointerdown', onDown, true));
    addEventListener('keydown', onKey);
    onCleanup(() => {
      document.removeEventListener('pointerdown', onDown, true);
      removeEventListener('keydown', onKey);
    });
  });

  const add = async (t: SaveTarget) => {
    close();
    try {
      const { added } = await api.addToPlaylist(t.id, p.id);
      if (added) forgetCollection(t.id);
      toast(added ? `Saved to ${t.title}` : `Already in ${t.title}`);
    } catch (e) {
      toast((e as Error).message);
    }
  };

  let title!: HTMLInputElement;
  let privacy!: HTMLSelectElement;
  const create = async (e: SubmitEvent) => {
    e.preventDefault();
    const name = title.value.trim();
    if (!name || busy()) return;
    setBusy(true);
    try {
      await api.createPlaylist(name, privacy.value, p.id);
      close();
      toast(`Saved to ${name}`);
    } catch (err) {
      setBusy(false);
      toast((err as Error).message);
    }
  };

  // Open above the anchor when it sits in the lower half (the player bar), else below.
  const above = p.y > innerHeight / 2;
  const style = {
    left: `${Math.max(8, Math.min(innerWidth - W - 8, p.x - W / 2))}px`,
    ...(above ? { bottom: `${innerHeight - p.y + 8}px` } : { top: `${p.y + 40}px` }),
  };

  return (
    <div ref={el} class="save-menu" style={style} role="dialog" aria-label="Save to playlist">
      <Show
        when={!creating()}
        fallback={
          <form class="save-new" onSubmit={create}>
            <h3>New playlist</h3>
            <input ref={(r) => ((title = r), queueMicrotask(() => r.focus()))} placeholder="Title" maxLength={150} />
            <select ref={privacy}>
              <option value="PRIVATE">Private</option>
              <option value="UNLISTED">Unlisted</option>
              <option value="PUBLIC">Public</option>
            </select>
            <div class="save-new-actions">
              <button type="button" class="btn btn-outline" onClick={() => setCreating(false)}>
                Cancel
              </button>
              <button class="btn btn-primary" disabled={busy()}>
                Create
              </button>
            </div>
          </form>
        }
      >
        <h3>Save to playlist</h3>
        <div class="save-list">
          <Show when={targets()} fallback={error() ? <div class="empty">{error()}</div> : <div class="spinner spinner-sm" />}>
            <For each={targets()} fallback={<div class="empty">No playlists yet.</div>}>
              {(t) => (
                <button class="save-item" onClick={() => add(t)}>
                  <img src={thumb(t.thumb, 40)} width="40" height="40" alt="" loading="lazy" />
                  <span>
                    <span class="save-title">{t.title}</span>
                    <span class="save-sub">{t.subtitle}</span>
                  </span>
                </button>
              )}
            </For>
          </Show>
        </div>
        <button class="save-item save-create" onClick={() => setCreating(true)}>
          <Icon name="add" />
          <span>New playlist</span>
        </button>
      </Show>
    </div>
  );
}

/** Mounted once by App: the popover and the toast. */
export function SaveLayer() {
  return (
    <>
      <Show when={saving()} keyed>
        {(s) => <SaveMenu {...s} />}
      </Show>
      <Show when={toastText()}>
        <div class="toast" role="status">
          {toastText()}
        </div>
      </Show>
    </>
  );
}
