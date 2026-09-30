const topics = new Map();

export function on(topic, fn) {
  if (!topics.has(topic)) topics.set(topic, new Set());
  topics.get(topic).add(fn);
  return () => topics.get(topic)?.delete(fn);
}

export function emit(topic, data) {
  for (const fn of topics.get(topic) ?? []) {
    try {
      fn(data);
    } catch (err) {
      console.error(`bus handler for ${topic} failed`, err);
    }
  }
}
