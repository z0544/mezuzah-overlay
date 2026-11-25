import http.server, threading, functools, os
from playwright.sync_api import sync_playwright
ROOT=os.path.dirname(os.path.dirname(os.path.abspath(__file__))); OUT=os.path.join(ROOT,'test','out')
class Q(http.server.SimpleHTTPRequestHandler):
    def log_message(self,*a): pass
srv=http.server.ThreadingHTTPServer(('127.0.0.1',8766),functools.partial(Q,directory=os.path.join(ROOT,'dist')))
threading.Thread(target=srv.serve_forever,daemon=True).start()
with sync_playwright() as p:
    b=p.chromium.launch(executable_path='/usr/bin/google-chrome')
    pg=b.new_page(viewport={'width':1440,'height':900}); pg.goto('http://localhost:8766/index.html')
    pg.click('label[for=tplText]'); pg.wait_for_timeout(700)
    pg.check('#bigLetters'); pg.wait_for_timeout(200)
    for w,h in [(10,10),(12,9)]:
        pg.fill('#w',str(w)); pg.fill('#h',str(h)); pg.wait_for_timeout(300)
        pg.locator('#previewCanvas').screenshot(path=f'{OUT}/text-{w}x{h}.png')
        print(w,h,pg.text_content('#dimSqueeze'))
    b.close()
srv.shutdown()
