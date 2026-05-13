// Runs inside the hidden scraper BrowserWindow on claude.ai/settings/usage.
// Exposes window.__scrapeUsage() which walks the rendered DOM and pulls the
// 5-hour and weekly progress bars + reset countdown text.

function pctFromStyle(el) {
  if (!el) return null;
  const style = el.getAttribute('style') || '';
  const m = style.match(/width:\s*([\d.]+)%/i);
  if (m) return parseFloat(m[1]);
  const aria = el.getAttribute('aria-valuenow');
  if (aria != null) return parseFloat(aria);
  return null;
}

function findBlock(labelRegex) {
  const all = Array.from(document.querySelectorAll('div, section, article'));
  for (const el of all) {
    const txt = (el.innerText || '').trim();
    if (labelRegex.test(txt) && txt.length < 400) return el;
  }
  return null;
}

function extractFromBlock(block) {
  if (!block) return null;
  const text = block.innerText || '';
  let percent = null;
  const pctMatch = text.match(/(\d{1,3})\s*%/);
  if (pctMatch) percent = parseInt(pctMatch[1], 10);
  if (percent == null) {
    const bar = block.querySelector('[role="progressbar"], [style*="width"]');
    percent = pctFromStyle(bar);
  }
  let reset = null;
  const resetMatch = text.match(/(reset[s]?(?: in)?)\s+([^\n]+)/i);
  if (resetMatch) reset = resetMatch[2].trim().split('\n')[0];
  return { percent, reset, raw: text.slice(0, 240) };
}

function scrape() {
  const fiveBlock = findBlock(/5[- ]?hour|five[- ]?hour|current session|usage limit/i);
  const weekBlock = findBlock(/week(ly)?|7[- ]?day|this week/i);
  return {
    fiveHour: extractFromBlock(fiveBlock),
    weekly: extractFromBlock(weekBlock),
    url: location.href,
    title: document.title,
  };
}

window.__scrapeUsage = scrape;
