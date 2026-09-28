// Runs the homeland layout (see layout.js) off the page's own thread, since a large homeland
// takes about a second: posts back what `layOut` returns for the pieces it's sent. Loaded with
// the page's own load tag (see `WORKER_URL` in app.js), passed on to layout.js so a cached older
// copy is never used with newer page code.
const ready = import('./layout.js' + new URL(import.meta.url).search);

self.onmessage = async (event) => {
    const { layOut } = await ready;
    self.postMessage(layOut(event.data.pieces));
};
