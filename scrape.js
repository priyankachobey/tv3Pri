// ✅ Drop-in update: closes most TradingView popups/overlays before scraping
// Works for: cookie banners, sign-in/subscribe modals, "continue" dialogs, tooltips,
// floating panels, full-screen overlays, etc.

async function safeGoto(page, url, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });

      // ✅ clear popups early + again after a short delay (SPA)
      await killPopups(page);
      await page.waitForTimeout(1500);
      await killPopups(page);

      // ✅ wait legend to appear (after popups are gone)
      await page.waitForSelector('[data-qa-id="legend"]', { timeout: 20000 });

      // ✅ one more popup cleanup (sometimes appears after chart loads)
      await killPopups(page);

      return true;
    } catch (err) {
      console.warn(`Retry ${i + 1} for ${url} – ${err.message}`);
      if (i === retries - 1) return false;
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
}

// always keep same column count
function fixedLength(arr, len, fill = "") {
  if (arr.length >= len) return arr.slice(0, len);
  return arr.concat(Array(len - arr.length).fill(fill));
}

// safe date builder (no //2025)
function buildDate(day, month, year) {
  if (!year) return "";
  if (!day && !month) return `${year}`;
  if (!day) day = "01";
  if (!month) month = "01";
  return `${String(day).padStart(2, "0")}/${String(month).padStart(2, "0")}/${year}`;
}

/**
 * ✅ POPUP KILLER (TradingView + generic)
 * - Sends ESC multiple times
 * - Clicks common close buttons (X, Close, Not now, Got it, Accept)
 * - Removes full-screen overlays/backdrops
 * - Prevents future modal traps by removing "overflow:hidden" on body/html
 */
async function killPopups(page) {
  // 1) ESC spam (many dialogs close with ESC)
  try {
    for (let k = 0; k < 3; k++) {
      await page.keyboard.press("Escape");
      await page.waitForTimeout(200);
    }
  } catch {}

  // 2) Click common close/accept buttons (works for cookie + modals)
  const clickSelectors = [
    // Generic close buttons
    'button[aria-label="Close"]',
    'button[title="Close"]',
    'button[data-name="close"]',
    'button[data-qa-id*="close"]',
    '[role="button"][aria-label="Close"]',
    '.close',
    '.close-button',
    '.tv-dialog__close',
    '.js-dialog__close',

    // Cookie banners / consent
    'button:has-text("Accept")',
    'button:has-text("I agree")',
    'button:has-text("Agree")',
    'button:has-text("Got it")',
    'button:has-text("OK")',
    'button:has-text("Allow")',
    'button:has-text("Continue")',
    'button:has-text("Reject")',
    'button:has-text("No thanks")',
    'button:has-text("Not now")',
    'button:has-text("Dismiss")',

    // TradingView-ish / subscription popups (text-based)
    '[role="button"]:has-text("Not now")',
    '[role="button"]:has-text("No thanks")',
    '[role="button"]:has-text("Got it")',
    '[role="button"]:has-text("Close")',
  ];

  // NOTE: :has-text works in Playwright. If you're on Puppeteer, it will ignore these
  // and still succeed due to the DOM-removal fallback below.
  try {
    for (const sel of clickSelectors) {
      const el = await page.$(sel);
      if (el) {
        try {
          await el.click({ delay: 20 });
          await page.waitForTimeout(250);
        } catch {}
      }
    }
  } catch {}

  // 3) Remove overlays/backdrops & unlock scroll (works even if selectors change)
  try {
    await page.evaluate(() => {
      const txt = (s) => (s || "").toLowerCase();

      // unlock scroll if some modal locked it
      document.documentElement.style.overflow = "auto";
      document.body.style.overflow = "auto";

      const suspects = Array.from(document.querySelectorAll("*"));

      for (const el of suspects) {
        const id = txt(el.id);
        const cls = txt(el.className?.toString?.() || "");
        const role = txt(el.getAttribute?.("role") || "");
        const aria = txt(el.getAttribute?.("aria-label") || "");
        const qaid = txt(el.getAttribute?.("data-qa-id") || "");

        const style = window.getComputedStyle(el);
        const isFixedFull =
          style.position === "fixed" &&
          (style.inset === "0px" || (style.top === "0px" && style.left === "0px")) &&
          (parseInt(style.width) >= window.innerWidth - 5 ||
            parseInt(style.height) >= window.innerHeight - 5);

        const looksLikeOverlay =
          isFixedFull &&
          (style.zIndex && parseInt(style.zIndex) >= 1000) &&
          (cls.includes("overlay") ||
            cls.includes("backdrop") ||
            cls.includes("modal") ||
            cls.includes("dialog") ||
            id.includes("overlay") ||
            id.includes("modal") ||
            role.includes("dialog") ||
            aria.includes("cookie") ||
            qaid.includes("consent"));

        // remove only likely overlays/backdrops (not main chart)
        if (looksLikeOverlay) el.remove();
      }

      // also remove common backdrops by keyword
      const keywords = ["backdrop", "overlay", "modal", "dialog", "popup", "consent"];
      for (const key of keywords) {
        document
          .querySelectorAll(`[class*="${key}"], [id*="${key}"]`)
          .forEach((n) => {
            const st = window.getComputedStyle(n);
            const z = parseInt(st.zIndex || "0");
            if (st.position === "fixed" && z >= 1000) n.remove();
          });
      }
    });
  } catch {}
}

export async function scrapeChart(page, url) {
  const EXPECTED_VALUE_COUNT = 25; // change if your sheet needs more/less columns

  try {
    const success = await safeGoto(page, url);

    if (!success) {
      return ["", "", ...fixedLength(["NAVIGATION FAILED"], EXPECTED_VALUE_COUNT)];
    }

    // ✅ popup cleanup once more right before scraping
    await killPopups(page);

    // example date creation (edit source if you scrape real day/month/year)
    const now = new Date();
    const dateString = buildDate(now.getDate(), now.getMonth() + 1, now.getFullYear());

    const values = await page.$$eval(
      '[data-qa-id="legend"] .item-l31H9iuA.study-l31H9iuA',
      (sections) => {
        const clubbed = [...sections].find((section) => {
          const title = section.querySelector(
            '[data-qa-id="legend-source-title"] .title-l31H9iuA'
          );
          const text = title?.innerText?.trim().toLowerCase();
          return text === "clubbed" || text === "l";
        });

        if (!clubbed) return ["CLUBBED NOT FOUND"];

        const valueSpans = clubbed.querySelectorAll(".valueValue-l31H9iuA");

        return [...valueSpans].map((el) => {
          const t = el.innerText.trim();
          return t === "∅" ? "None" : t;
        });
      }
    );

    // first two blanks = shift by 2 columns
    // then fixed number of values so sheet never shifts
    return ["", "", dateString, ...fixedLength(values, EXPECTED_VALUE_COUNT - 1)];
  } catch (err) {
    console.error(`Error scraping ${url}:`, err.message);
    return ["", "", ...fixedLength(["ERROR"], EXPECTED_VALUE_COUNT)];
  }
}
