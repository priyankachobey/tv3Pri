import sys
import os
import time
import json
import random
from datetime import date
from selenium import webdriver
from selenium.webdriver.chrome.service import Service
from selenium.webdriver.chrome.options import Options
from selenium.webdriver.common.by import By
from selenium.webdriver.support.ui import WebDriverWait
from selenium.webdriver.support import expected_conditions as EC
import gspread
from webdriver_manager.chrome import ChromeDriverManager
from bs4 import BeautifulSoup

def log(msg):
    t = time.strftime("%H:%M:%S")
    print(f"[{t}] {msg}", flush=True)

# ---------------- CONFIG ---------------- #
SHARD_INDEX = int(os.getenv("SHARD_INDEX", "0"))
SHARD_SIZE  = int(os.getenv("SHARD_SIZE", "500"))
START_ROW = SHARD_INDEX * SHARD_SIZE
END_ROW   = START_ROW + SHARD_SIZE

checkpoint_file = os.getenv("CHECKPOINT_FILE", f"checkpoint_{SHARD_INDEX}.txt")
last_i = int(open(checkpoint_file).read().strip()) if os.path.exists(checkpoint_file) else START_ROW

CHROME_DRIVER_PATH = ChromeDriverManager().install()

def create_driver():
    opts = Options()
    opts.add_argument("--headless=new")
    opts.add_argument("--no-sandbox")
    opts.add_argument("--disable-dev-shm-usage")
    opts.add_argument("--disable-gpu")
    # Speed Optimization: Disable features not needed for scraping
    opts.add_argument("--disable-extensions")
    opts.add_argument("--dns-prefetch-disable")
    opts.add_argument("--blink-settings=imagesEnabled=false") 
    opts.add_experimental_option("excludeSwitches", ["enable-logging"])
    
    driver = webdriver.Chrome(service=Service(CHROME_DRIVER_PATH), options=opts)
    driver.set_page_load_timeout(60)

    if os.path.exists("cookies.json"):
        try:
            driver.get("https://in.tradingview.com/")
            with open("cookies.json", "r") as f:
                cookies = json.load(f)
            for c in cookies:
                driver.add_cookie({k: v for k, v in c.items() if k in ("name", "value", "path", "secure", "expiry")})
            driver.refresh()
        except: pass
    return driver

def scrape_tradingview(driver, url, url_type=""):
    log(f"   📡 Loading {url_type}...")
    try:
        driver.get(url)
        # Smart Wait: Check every 2 seconds if data exists, up to 20 seconds total
        # This is much faster than a fixed 25s sleep.
        found_values = []
        for _ in range(10): 
            soup = BeautifulSoup(driver.page_source, "html.parser")
            raw = [el.get_text().strip() for el in soup.find_all("div", class_=lambda x: x and 'valueValue' in x)]
            if raw:
                found_values = [str(v) for v in raw if v.strip()]
                break
            time.sleep(2) 
        
        if found_values:
            log(f"   ✅ Found {len(found_values)} values.")
            return found_values
    except Exception as e:
        log(f"   ❌ Error: {str(e)[:50]}")
    return []

# ---------------- MAIN ---------------- #
try:
    gc = gspread.service_account("credentials.json")
    sheet_main = gc.open("Stock List").worksheet("Sheet1")
    sheet_data = gc.open("MV2 for SQL").worksheet("Sheet2")
    
    company_list = sheet_main.col_values(1)
    url_d_list = sheet_main.col_values(4)
    url_h_list = sheet_main.col_values(8)
except Exception as e:
    log(f"❌ Setup Error: {e}"); sys.exit(1)

driver = create_driver()
batch_list = []
BATCH_SIZE = 30 # Increased batch size for fewer API hits
current_date = date.today().strftime("%m/%d/%Y")

try:
    for i in range(last_i, min(END_ROW, len(company_list))):
        name = company_list[i].strip()
        log(f"--- [ROW {i+1}] {name} ---")
        
        u_d = url_d_list[i] if i < len(url_d_list) and url_d_list[i].startswith("http") else None
        u_h = url_h_list[i] if i < len(url_h_list) and url_h_list[i].startswith("http") else None
        
        # Scrape Daily
        vals_d = scrape_tradingview(driver, u_d, "D") if u_d else []
        # Scrape Hourly
        vals_h = scrape_tradingview(driver, u_h, "H") if u_h else []
        
        combined = vals_d + vals_h
        row_idx = i + 1
        batch_list.append({"range": f"A{row_idx}", "values": [[name]]})
        batch_list.append({"range": f"J{row_idx}", "values": [[current_date]]})
        if combined:
            batch_list.append({"range": f"K{row_idx}", "values": [combined]})
        
        if len(batch_list) // 3 >= BATCH_SIZE:
            sheet_data.batch_update(batch_list, value_input_option='RAW')
            batch_list = []
            log("🚀 Batch Saved.")

        with open(checkpoint_file, "w") as f:
            f.write(str(i + 1))

finally:
    if batch_list: sheet_data.batch_update(batch_list, value_input_option='RAW')
    driver.quit()
    log("🏁 Done.")
