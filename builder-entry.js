// THE BUILDER, STARTED AS AN APP (ARCHITECTURE §19; app-as-data P5): published like every app -- its files are
// `f/` records of its definition and this module is its `meta.entry`. The loader hands it the SDK it loaded and the
// builder's linked modules; this puts the builder's own page (its `index.html` record: styles and body) in place of
// the loader's, gives the SDK to the builder's one SDK door (sdk-loader.js), and runs the builder (app.js).
export async function start({ sdk, files, urls, port }) {
  const html = files.get("index.html");
  if (!html) throw new Error("the builder's index.html is not among its files");
  const page = new DOMParser().parseFromString(new TextDecoder().decode(html), "text/html");
  for (const s of page.head.querySelectorAll("style")) document.head.append(document.importNode(s, true));
  for (const s of page.body.querySelectorAll("script")) s.remove();
  document.body.replaceChildren(...[...page.body.childNodes].map(n => document.importNode(n, true)));
  const { useOwnFiles } = await import(urls.get("builder-files.js"));
  useOwnFiles(files);
  const { useLoaded } = await import(urls.get("sdk-loader.js"));
  useLoaded(sdk, { port });
  await import(urls.get("app.js"));
}
