# craftworks-builder

Drag-and-drop app builder. Components bind to paths in the tree; each is enabled
the phase its substrate capability lands. 
    ../craftworks-sdk/build.sh && ./build.sh    # bring in the SDK
    ./serve.sh                                  # http://127.0.0.1:8088
    npm test

The builder reaches the platform only through the SDK (`sdk-loader.js`).
