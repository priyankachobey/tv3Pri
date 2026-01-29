async function safeGoto(page, url, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
      await page.waitForSelector('[data-qa-id="legend"]', { timeout: 15000 });
      return true;
    } catch (err) {
      console.warn(`Retry ${i + 1} for ${url} – ${err.message}`);
      if (i === retries - 1) return false;
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
}

// make fixed length array so columns never shift
function fixedLength(arr, len, fill = "") {
  if (arr.length >= len) return arr.slice(0, len);
  return arr.concat(Array(len - arr.length).fill(fill));
}

export async function scrapeChart(page, url) {
  const EXPECTED_VALUE_COUNT = 25; 
  // how many legend values your sheet has after shifting 2 columns
  // change this number if your sheet has more/less columns

  try {
    const success = await safeGoto(page, url);

    // if page not loaded → return same column count
    if (!success) {
      return ["", "", ...fixedLength(["NAVIGATION FAILED"], EXPECTED_VALUE_COUNT)];
    }

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

    // shift by 2 columns but keep fixed total length
    return ["", "", ...fixedLength(values, EXPECTED_VALUE_COUNT)];
  } catch (err) {
    console.error(`Error scraping ${url}:`, err.message);
    return ["", "", ...fixedLength(["ERROR"], EXPECTED_VALUE_COUNT)];
  }
}
