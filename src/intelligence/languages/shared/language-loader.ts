/** Share in-flight WASM initialization and grammar loads; evict failed attempts. */
export function createLanguageLoader<T>(
  initialize: () => Promise<void>,
  load: (id: string) => Promise<T>,
): (id: string) => Promise<T> {
  let initialized: Promise<void> | undefined;
  const languages = new Map<string, Promise<T>>();
  return async (id) => {
    initialized ??= Promise.resolve().then(initialize);
    const initializing = initialized;
    try {
      await initializing;
    } catch (error) {
      if (initialized === initializing) initialized = undefined;
      throw error;
    }
    let loading = languages.get(id);
    if (!loading) {
      loading = Promise.resolve().then(() => load(id));
      languages.set(id, loading);
      const attempt = loading;
      void attempt.catch(() => {
        if (languages.get(id) === attempt) languages.delete(id);
      });
    }
    return await loading;
  };
}
