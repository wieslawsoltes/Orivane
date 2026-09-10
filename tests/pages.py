"""Exercise the real static deployment, including editing and IndexedDB reload.
Requires Python Playwright + Chromium. Never mocks storage, APIs or rendering.
"""
import argparse
import json
import os
import time
from pathlib import Path
from urllib.parse import urljoin
from urllib.request import Request, urlopen
from playwright.sync_api import sync_playwright

parser = argparse.ArgumentParser()
parser.add_argument('--url', default='http://localhost:8080/')
parser.add_argument('--expected-commit', default='')
parser.add_argument('--output', default='test-results/pages')
args = parser.parse_args()
base = args.url.rstrip('/') + '/'
out = Path(args.output)
out.mkdir(parents=True, exist_ok=True)
report = {'url': base, 'checks': [], 'errors': []}


def passed(name, **detail):
    report['checks'].append({'name': name, 'status': 'pass', **detail})
    print('PASS:', name, detail, flush=True)


def request(relative):
    req = Request(urljoin(base, relative), headers={'Cache-Control': 'no-cache'})
    with urlopen(req, timeout=20) as response:
        assert response.status == 200, (relative, response.status)
        return response.read()


def wait_ready(page):
    page.wait_for_function('window.orivane?.ready === true', timeout=45000)
    page.locator('#loading').wait_for(state='hidden')


try:
    # GitHub's CDN may need a short propagation interval after deployment.
    deadline = time.monotonic() + 120
    while True:
        try:
            metadata = json.loads(request('build.json?check=' + str(time.time_ns())))
            assert metadata['name'] == 'orivane' and metadata['version'] == '0.2.0'
            if args.expected_commit:
                assert metadata['commit'] == args.expected_commit, metadata['commit']
            break
        except Exception:
            if time.monotonic() >= deadline:
                raise
            time.sleep(3)
    report['build'] = metadata
    assert b'Orivane' in request('index.html')
    assert b'app.js' in request('index.html')
    assert b'orivane' in request('Orivane.html')
    passed('Published HTML, portable edition and exact source commit')
    with sync_playwright() as p:
        options = {'headless': True, 'args': ['--no-sandbox']}
        if os.environ.get('CHROMIUM'):
            options['executable_path'] = os.environ['CHROMIUM']
        browser = p.chromium.launch(**options)
        ctx = browser.new_context(viewport={'width': 1440, 'height': 960})
        page = ctx.new_page()
        page.on('pageerror', lambda error: report['errors'].append(str(error)))
        response = page.goto(base, wait_until='domcontentloaded')
        assert response and response.status == 200
        wait_ready(page)
        assert page.evaluate('orivane.doc.objects().length') > 0
        assert page.evaluate('orivane.connected.available') is False
        passed('Real module application boots in static local-editor mode', renderer=page.evaluate('orivane.renderer.mode'))
        page.screenshot(path=str(out / 'desktop-light.png'))
        note = page.evaluate('orivane.api.addObject("sticky",100,100,{text:"Before Pages edit"})')
        page.evaluate('id => { orivane.api.select([id]); orivane.fitSelection(); orivane.editor.editText(orivane.doc.get(id)); }', note)
        page.locator('.canvas-editor').fill('Published editor verified')
        page.locator('.canvas-editor').press('Control+Enter')
        assert page.evaluate('id=>orivane.doc.get(id).text', note) == 'Published editor verified'
        page.evaluate('orivane.api.undo()')
        assert page.evaluate('id=>orivane.doc.get(id).text', note) == 'Before Pages edit'
        page.evaluate('orivane.api.redo()')
        assert page.evaluate('id=>orivane.doc.get(id).text', note) == 'Published editor verified'
        passed('Sticky creation, actual inline text editing, undo and redo')
        assert page.evaluate('orivane.storage.mode') == 'IndexedDB'
        board_id = page.evaluate('orivane.boardId')
        assert page.evaluate('async () => { await orivane.saveBoard(); return !!(await orivane.storage.get("boards",orivane.boardId)); }')
        page.reload(wait_until='domcontentloaded')
        wait_ready(page)
        assert page.evaluate('orivane.boardId') == board_id
        assert page.evaluate('id=>orivane.doc.get(id).text', note) == 'Published editor verified'
        passed('Committed IndexedDB board and text survive page reload')
        page.evaluate('orivane.toggleTheme()')
        assert page.locator('body').evaluate('e=>e.classList.contains("dark")')
        page.evaluate('orivane.fit()')
        page.screenshot(path=str(out / 'desktop-dark.png'))
        passed('Dark theme renders')
        mobile = browser.new_context(viewport={'width': 390, 'height': 844}, is_mobile=True, has_touch=True, device_scale_factor=2)
        mp = mobile.new_page()
        mp.on('pageerror', lambda error: report['errors'].append(str(error)))
        mp.goto(base, wait_until='domcontentloaded')
        wait_ready(mp)
        assert mp.evaluate('document.documentElement.scrollWidth <= window.innerWidth')
        mp.screenshot(path=str(out / 'mobile.png'))
        passed('Touch-sized mobile workspace boots without horizontal overflow')
        assert not report['errors'], report['errors']
        passed('No uncaught JavaScript exceptions')
        browser.close()
    report['status'] = 'pass'
except Exception as error:
    report['status'] = 'fail'
    report['failure'] = repr(error)
    raise
finally:
    (out / 'report.json').write_text(json.dumps(report, indent=2), encoding='utf8')
