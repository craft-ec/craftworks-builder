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
