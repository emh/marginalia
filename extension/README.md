# Marginalia Capture Extension

This unpacked Chrome extension saves the current browser tab into Marginalia when direct worker extraction cannot read the page.

## Install for development

1. Open `chrome://extensions`.
2. Enable Developer mode.
3. Choose Load unpacked.
4. Select this `extension` directory.
5. Open the extension options and confirm the Marginalia URL. The default is `https://emh.io/marginalia/`.

## Flow

1. Open an article page in Chrome.
2. Click the Marginalia extension action.
3. The extension reads the visible article DOM from the active tab.
4. The extension opens Marginalia with a one-time `capture` id.
5. Marginalia receives the captured payload and saves it through `/api/capture`.

The extension only injects the article reader into the active tab after you click the extension action.
