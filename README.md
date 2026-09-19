# craftworks-builder

Drag-and-drop app builder. Components bind to paths in the tree; each is enabled
the phase its substrate capability lands. 
    ../craftworks-sdk/build.sh && ./build.sh    # bring in the SDK
    ./serve.sh                                  # http://127.0.0.1:8088
    npm test

The builder reaches the platform only through the SDK (`sdk-loader.js`).

The builder always shows the data structure: the tree address, the key ranges the
app uses (left), and for the selected component its primitive, schema, key
patterns, contracts and where writes go (right). `catalogue.js` is the source of
that mapping and is validated by `tests/catalogue.test.mjs`. An app definition can
be passed in the URL: `#app=<json>`.

**Preview** runs the app inside the builder over the SDK (`runtime.js`; the published app will use the same module). Table, Form and List are live; the tree panel shows real record counts; an app's `schemas` and `seed` rows are part of its definition. `npm test` includes a real-browser test that drives headless Chrome (set `CHROME` if it lives elsewhere).
