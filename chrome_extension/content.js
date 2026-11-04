;(function(){ if (/streamlit/i.test(document.title)) return;

// Remove meta CSP tags
document.querySelectorAll('meta[http-equiv="Content-Security-Policy"]').forEach(e => e.remove());

// NOTE: the legacy TID/DOM command channel was removed on purpose.
// Any web page could forge an element with the TID id and make the extension
// read cookies for ANY domain or issue CDP commands — an unfixable hole, since
// the DOM is shared between the page and this content script and the sender
// cannot be authenticated. All bridge traffic now flows through the extension
// service worker directly (WS → handleExtMessage / executeScript).
})();