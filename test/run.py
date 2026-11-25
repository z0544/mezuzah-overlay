"""E2E test: 2D UI screenshots + emulated WebXR session (IWER, Quest 3 profile)."""
import http.server, threading, functools, json, sys, os
from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'test', 'out')
H = functools.partial(http.server.SimpleHTTPRequestHandler, directory=os.path.join(ROOT, 'dist'))
class Q(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a): pass
srv = http.server.ThreadingHTTPServer(('127.0.0.1', 8765), functools.partial(Q, directory=os.path.join(ROOT, 'dist')))
threading.Thread(target=srv.serve_forever, daemon=True).start()
URL = 'http://localhost:8765/index.html'
IWER = open(os.path.join(OUT, 'iwer.js')).read()
fails = []
def check(name, cond, info=''):
    print(('PASS ' if cond else 'FAIL ') + name + (f'  [{info}]' if info else ''))
    if not cond: fails.append(name)

with sync_playwright() as p:
    b = p.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'])
    # --- 2D without XR: preview only ---
    for w, h, name in [(1440, 900, 'desktop'), (360, 780, 'mobile')]:
        pg = b.new_page(viewport={'width': w, 'height': h})
        errs = []; pg.on('pageerror', lambda e: errs.append(str(e)))
        pg.goto(URL); pg.wait_for_timeout(400)
        pg.screenshot(path=f'{OUT}/ui-{name}.png', full_page=True)
        sw = pg.evaluate('document.documentElement.scrollWidth')
        check(f'no horizontal scroll {name}', sw <= w, f'scrollWidth={sw}')
        check(f'no page errors {name}', not errs, '; '.join(errs))
        st = pg.text_content('#xrStatusText')
        check(f'status without XR {name}', 'תצוגה מקדימה' in st, st)
        check(f'enter disabled without XR {name}', pg.is_disabled('#enterAR'))
        pg.fill('#w', '65'); pg.wait_for_timeout(50)
        check(f'invalid width flagged {name}', pg.get_attribute('#w', 'aria-invalid') == 'true')
        pg.fill('#w', '10'); pg.wait_for_timeout(50)
        pg.close()

    # --- mezuzah text template ---
    pg = b.new_page(viewport={'width': 1440, 'height': 900})
    errs = []; pg.on('pageerror', lambda e: errs.append(str(e)))
    pg.goto(URL); pg.click('label[for=tplText]'); pg.wait_for_timeout(800)
    tx = pg.evaluate('window.__mezuzah.text()')
    check('text template ready', tx['ready'] and not tx['error'], json.dumps(tx, ensure_ascii=False))
    check('text hash matches', tx['hash'] == 'a74a44b7c1fe7bb6d423ccada6ad47b33de902c7a0641ed88e8854a4304b0db4', tx['hash'])
    check('proof list has 22 lines', pg.locator('#proofLines li').count() == 22)
    check('rows locked to 22 in text mode', pg.is_disabled('#rows') and pg.input_value('#rows') == '22')
    check('no page errors text', not errs, '; '.join(errs))
    pg.click('#textProof summary')
    pg.screenshot(path=f'{OUT}/ui-text.png', full_page=True)
    pg.locator('#previewCanvas').screenshot(path=f'{OUT}/text-preview.png')
    pg.close()

    # --- image template: synthetic "ink" image ---
    pg = b.new_page(viewport={'width': 1440, 'height': 900})
    pg.goto(URL)
    pg.click('label[for=tplImg]')
    pg.wait_for_timeout(100)
    check('enter disabled w/o image', pg.is_disabled('#enterAR'))
    png = pg.evaluate('''async()=>{const c=document.createElement('canvas');c.width=1200;c.height=1000;const x=c.getContext('2d');
      x.fillStyle='#f3ead2';x.fillRect(0,0,1200,1000);x.fillStyle='#111';
      for(let i=0;i<22;i++){for(let j=0;j<9;j++){x.fillRect(150+j*100,100+i*36,70,20)}}
      const b=await new Promise(r=>c.toBlob(r,'image/png'));const a=new Uint8Array(await b.arrayBuffer());return Array.from(a)}''')
    import tempfile
    fp = os.path.join(OUT, 'synthetic-tikkun.png'); open(fp, 'wb').write(bytes(png))
    pg.set_input_files('#imgFile', fp); pg.wait_for_timeout(800)
    hash_txt = pg.text_content('#imgHash') or ''
    check('hash shown', hash_txt.startswith('SHA-256: ') and len(hash_txt) > 70, hash_txt[:40])
    hval = float(pg.input_value('#h'))
    # synthetic block after trim: width 870, height 21*36+20=776 -> aspect .892 -> 10cm * .892
    check('aspect-derived height', abs(hval - 8.92) < 0.05, str(hval))
    pg.screenshot(path=f'{OUT}/ui-image.png', full_page=True)
    pg.close()

    # --- emulated XR ---
    ctx = b.new_context(viewport={'width': 1280, 'height': 800})
    ctx.add_init_script(IWER)
    pg = ctx.new_page()
    errs = []; pg.on('pageerror', lambda e: errs.append(str(e)))
    logs = []; pg.on('console', lambda m: logs.append(m.text) if m.type == 'error' else None)
    pg.goto(URL); pg.wait_for_timeout(500)
    check('status ready with XR', 'מוכן' in pg.text_content('#xrStatusText'), pg.text_content('#xrStatusText'))
    pg.click('label[for=tplText]'); pg.wait_for_timeout(600)
    pg.fill('#w', '0'); pg.wait_for_timeout(50)
    check('invalid input blocks AR', pg.is_disabled('#enterAR'))
    pg.fill('#w', '10'); pg.wait_for_timeout(50)
    check('valid input re-enables AR', not pg.is_disabled('#enterAR'))
    pg.click('#enterAR'); pg.wait_for_timeout(800)
    S = lambda: pg.evaluate('window.__mezuzah.state()')
    check('in XR session', S()['inXR'], json.dumps(S()))
    if pg.is_visible('#arErr'): print('arErr:', pg.text_content('#arErr'))

    def tap(pt):
        pg.evaluate('''([x,y,z])=>{const c=__dev.controllers.right;c.position.set(x,y,z+0.012);c.quaternion.set(0,0,0,1);}''', pt)
        pg.wait_for_timeout(150)
        pg.evaluate("__dev.controllers.right.updateButtonValue('trigger',1)"); pg.wait_for_timeout(150)
        pg.evaluate("__dev.controllers.right.updateButtonValue('trigger',0)"); pg.wait_for_timeout(150)

    # wrong corner order (top-left first) must be rejected, not mirrored
    tap([-0.05, 0.8, -0.45]); tap([0.05, 0.8, -0.45]); tap([0.05, 0.8, -0.35])
    check('wrong corner order rejected', not S()['locked'] and S()['step'] == 0 and 'סדר' in S()['msg'], S()['msg'])
    # klaf lying on a table, 10 cm writing block, user looking down at it
    tap([0.05, 0.8, -0.45]);  check('calib step 1', S()['step'] == 1, json.dumps(S()))
    tap([0.055, 0.8, -0.45]); check('reject too-close point', S()['step'] == 1 and 'קרובה' in S()['msg'], S()['msg'])
    tap([-0.05, 0.8, -0.45]); check('calib step 2', S()['step'] == 2)
    tap([0.0, 0.8, -0.45]);   check('reject colinear point', S()['step'] == 2 and 'קו' in S()['msg'], S()['msg'])
    tap([-0.05, 0.8, -0.35])
    st = S(); check('locked after 3 points', st['locked'], json.dumps(st))
    m = st.get('measured') or {}
    check('measured ~10x10cm', abs(m.get('mw', 0) - 10) < 0.05 and abs(m.get('mh', 0) - 10) < 0.05, json.dumps(m))

    def press(hand, btn):
        pg.evaluate(f"__dev.controllers.{hand}.updateButtonValue('{btn}',1)"); pg.wait_for_timeout(120)
        pg.evaluate(f"__dev.controllers.{hand}.updateButtonValue('{btn}',0)"); pg.wait_for_timeout(120)
    import base64
    def snap(name, d=0.3):
        u = pg.evaluate(f'window.__mezuzah.snapshot({d})')
        if u: open(f'{OUT}/{name}.png','wb').write(base64.b64decode(u.split(',')[1]))
        return bool(u)
    pg.wait_for_timeout(300); check('xr snapshot full', snap('xr-full')); snap('xr-wide', 0.55)
    press('right', 'a-button'); check('A -> next line', S()['line'] == 1, str(S()['line']))
    press('right', 'b-button'); press('right', 'b-button'); check('B wraps to last line', S()['line'] == 21, str(S()['line']))
    press('left', 'x-button'); check('X -> line mode', S()['mode'] == 'line', S()['mode'])
    press('right', 'a-button'); press('right', 'a-button'); press('right', 'a-button'); pg.wait_for_timeout(200); snap('xr-line')
    op0 = S()['opacity']; press('left', 'y-button'); check('Y -> opacity cycles', S()['opacity'] != op0, f"{op0}->{S()['opacity']}")
    pg.evaluate("__dev.controllers.right.updateAxes('thumbstick',1,0)"); pg.wait_for_timeout(200)
    pg.evaluate("__dev.controllers.right.updateAxes('thumbstick',0,0)"); pg.wait_for_timeout(100)
    dx = S()['adj']['dx']; check('right stick nudge 0.5mm', abs(dx - 0.0005) < 1e-9, str(dx))
    for _ in range(14):
        pg.evaluate("__dev.controllers.left.updateAxes('thumbstick',0,1)"); pg.wait_for_timeout(130)
        pg.evaluate("__dev.controllers.left.updateAxes('thumbstick',0,0)"); pg.wait_for_timeout(60)
    dz = S()['adj']['dz']; check('dz clamped to 5mm', abs(dz - 0.005) < 1e-9, str(dz))
    pg.evaluate("__dev.controllers.left.updateAxes('thumbstick',1,0)"); pg.wait_for_timeout(200)
    pg.evaluate("__dev.controllers.left.updateAxes('thumbstick',0,0)"); pg.wait_for_timeout(100)
    rot = S()['adj']['rot']; check('left stick rotate 0.1deg', abs(abs(rot) - 0.0017453) < 1e-5, str(rot))
    pg.wait_for_timeout(150); snap('xr-adjusted', 0.55)
    press('right', 'thumbstick'); a = S()['adj']
    check('stick click resets nudges', a['dx'] == 0 and a['dz'] == 0 and a['rot'] == 0, json.dumps(a))
    # double grip hold -> recalibrate
    pg.evaluate("__dev.controllers.left.updateButtonValue('squeeze',1);__dev.controllers.right.updateButtonValue('squeeze',1)")
    pg.wait_for_timeout(1400)
    pg.evaluate("__dev.controllers.left.updateButtonValue('squeeze',0);__dev.controllers.right.updateButtonValue('squeeze',0)")
    pg.wait_for_timeout(150)
    check('double grip -> recalibrate', not S()['locked'] and S()['step'] == 0, json.dumps(S()))
    check('no page errors XR', not errs, '; '.join(errs))
    check('no console errors XR', not logs, '; '.join(logs[:3]))
    # vertical (wall) mount check: block facing the user
    tap([0.06, 1.3, -0.5]); tap([-0.06, 1.3, -0.5]); tap([-0.06, 1.18, -0.5])
    check('size gap requires confirmation', S()['locked'] and S()['confirm'], json.dumps(S()))
    pg.wait_for_timeout(150); snap('xr-confirm', 0.55)
    press('right', 'a-button'); check('buttons inert while confirming', S()['line'] == 0)
    tap([0.0, 1.25, -0.5]); check('trigger confirms', not S()['confirm'] and S()['locked'])
    m = S().get('measured') or {}
    check('wall calibration 12x12', S()['locked'] and abs(m.get('mw', 0) - 12) < 0.05 and abs(m.get('mh', 0) - 12) < 0.05, json.dumps(m))
    pg.evaluate('navigator.xr && 0')
    b.close()
srv.shutdown()
print('\nRESULT:', 'ALL PASS' if not fails else f'{len(fails)} FAILED: ' + ', '.join(fails))
sys.exit(1 if fails else 0)
