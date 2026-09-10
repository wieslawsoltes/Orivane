"""Run existing browser suites with external polling under strict server CSP.

Some Chromium/Playwright versions evaluate wait_for_function predicates inside
an animation callback, where script-src 'self' correctly rejects eval(). This
runner polls the same predicates through the browser's automation protocol.
It does not alter app source, headers, browser CSP, storage, APIs or assertions.
All existing suite checks run unchanged. Successful waits return JSHandle.
"""
import runpy
import sys
import time
from pathlib import Path
from playwright.sync_api import Error, Page, TimeoutError


def wait_external(page, expression, *, arg=None, timeout=None, polling=None):
    duration = 30000 if timeout is None else timeout
    interval = 50 if polling in (None, 'raf') else float(polling)
    if interval <= 0:
        raise ValueError('Polling interval must be positive')
    deadline = time.monotonic() + duration / 1000 if duration else float('inf')
    while True:
        handle = None
        try:
            handle = page.evaluate_handle(expression, arg)
            if handle.evaluate('(value) => !!value'):
                return handle
        except Error as error:
            if 'Execution context was destroyed' not in str(error):
                raise
        finally:
            # Return handles stay alive; only false predicate results are disposed.
            if handle is not None:
                try:
                    if not handle.evaluate('(value) => !!value'):
                        handle.dispose()
                except Error:
                    pass
        if time.monotonic() >= deadline:
            raise TimeoutError(f'External predicate polling timed out after {duration} ms: {expression}')
        page.wait_for_timeout(interval)


if __name__ == '__main__':
    if len(sys.argv) < 2:
        raise SystemExit('Usage: python tools/run-browser-tests.py tests/browser.py [suite options]')
    target = Path(sys.argv[1]).resolve()
    root = Path(__file__).resolve().parents[1]
    if target not in {root / 'tests/browser.py', root / 'tests/browser-connected.py'}:
        raise SystemExit('Choose an existing Orivane browser suite')
    sys.argv = [str(target), *sys.argv[2:]]
    original = Page.wait_for_function
    Page.wait_for_function = wait_external
    print('CSP-safe external predicate polling; all app security policies and test assertions unchanged.', flush=True)
    try:
        runpy.run_path(str(target), run_name='__main__')
    finally:
        Page.wait_for_function = original
