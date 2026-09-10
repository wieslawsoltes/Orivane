#!/usr/bin/env python3
"""Real Chromium UI smoke suite. Run a local server for the normal-origin path.

  python tests/browser.py --url http://localhost:4173
  python tests/browser.py --injected

The injected path is for managed environments that prohibit navigation. It
executes the unmodified standalone build using set_content on about:blank. No application or browser APIs are replaced. The application itself provides a
clearly labeled volatile-storage fallback. This mode does
NOT test secure-context WebGPU, IndexedDB durability, or browser HTTP transport.
Server + real streaming client transport is covered by tests/server.test.js.
"""
import argparse
import json
import os
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--injected', action='store_true')
    parser.add_argument('--url', default='http://localhost:4173')
    parser.add_argument('--chromium', default=os.environ.get('CHROMIUM', '/usr/bin/chromium'))
    args = parser.parse_args()
    out = ROOT / 'test-results'
    out.mkdir(exist_ok=True)
    results, errors = [], []

    def passed(name, detail=None):
        results.append({'test': name, 'passed': True, 'detail': detail})
        print('PASS', name, detail or '', flush=True)

    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path=args.chromium, headless=True, args=['--no-sandbox'])
        page = browser.new_page(viewport={'width': 1600, 'height': 1000})
        page.set_default_timeout(6000)
        page.on('pageerror', lambda e: errors.append(str(e)))

        def load(target):
            if args.injected:
                target.set_content((ROOT / 'dist/Orivane.html').read_text(), wait_until='domcontentloaded')
            else:
                target.goto(args.url)
            target.wait_for_function('window.orivane?.ready === true')
            target.wait_for_timeout(200)

        def ev(code, value=None):
            return page.evaluate(code, value)

        def action(name):
            page.locator(f'[data-action="{name}"]:visible').first.click()

        def point(x, y):
            return ev('([x,y]) => {const p=orivane.camera.screen({x,y}),r=document.querySelector("#interaction").getBoundingClientRect();return {x:p.x+r.left,y:p.y+r.top}}', [x,y])

        def click_world(x, y):
            q = point(x, y)
            page.mouse.click(q['x'], q['y'])

        def drag_world(x1, y1, x2, y2):
            a, b = point(x1,y1), point(x2,y2)
            page.mouse.move(a['x'],a['y']); page.mouse.down()
            page.mouse.move(b['x'],b['y'],steps=10); page.mouse.up()

        try:
            load(page)
            env = ev('({gpuAvailable:!!navigator.gpu,secureContext:isSecureContext,mode:orivane.renderer.mode,storage:orivane.storage.mode,objects:orivane.doc.objects().length,userAgent:navigator.userAgent})')
            assert env['objects'] == 42
            page.screenshot(path=str(out / 'desktop.png'))
            passed('Boot, original editable discovery board, desktop rendering', env)

            action('templates')
            assert page.get_by_role('dialog').count() == 1
            assert ev('document.querySelectorAll(".template-card").length') >= 10
            action('modal-close')
            action('boards')
            assert page.get_by_role('dialog').count() == 1
            action('new-board')
            page.wait_for_function('orivane.doc.objects().length === 0')
            ev('Object.assign(orivane.camera,{x:160,y:180,zoom:1});orivane.state.smartSnap=false;orivane.invalidate()')
            passed('Workspace, ten-template catalog, new blank board')

            page.locator('#interaction').focus()
            page.keyboard.press('n')
            click_world(100,100)
            page.locator('.canvas-editor').fill('A genuinely editable idea')
            page.locator('.canvas-editor').press('Control+Enter')
            note = ev('orivane.doc.objects()[0].id')
            assert ev('orivane.doc.objects()[0].text') == 'A genuinely editable idea'
            drag_world(180,180,240,215)
            moved = ev('id=>orivane.doc.get(id)',note)
            assert abs(moved['x']-160)<1 and abs(moved['y']-135)<1
            # Side grip, not only a corner.
            drag_world(moved['x']+moved['w'],moved['y']+moved['h']/2,moved['x']+moved['w']+65,moved['y']+moved['h']/2)
            resized=ev('id=>orivane.doc.get(id)',note)
            assert abs(resized['w']-235)<1 and abs(resized['h']-170)<1
            action('undo'); assert ev('id=>orivane.doc.get(id).w',note)==170
            action('redo'); assert ev('id=>orivane.doc.get(id).w',note)==235
            passed('Sticky creation, inline editing, drag, side resize, undo and redo')

            cx,cy=resized['x']+resized['w']/2,resized['y']+resized['h']/2
            drag_world(cx,resized['y']-28,cx+110,cy)
            assert abs(ev('id=>orivane.doc.get(id).rotation',note)-90)<1
            action('undo')
            page.locator('#interaction').focus(); page.keyboard.press('Control+d')
            assert ev('orivane.doc.objects().length')==2
            page.keyboard.press('Control+a');page.keyboard.press('Control+g')
            assert ev('new Set(orivane.doc.objects().map(o=>o.group)).size')==1
            page.keyboard.press('Delete'); assert ev('orivane.doc.objects().length')==0
            page.keyboard.press('Control+z'); assert ev('orivane.doc.objects().length')==2
            passed('Rotation, duplication, select-all, grouping, deletion and recovery')

            ev('orivane.api.select(orivane.doc.objects().map(o=>o.id));orivane.editor.remove()')
            left=ev('orivane.api.addObject("rect",100,100,{w:180,h:100,text:"Start"})')
            right=ev('orivane.api.addObject("rect",500,100,{w:180,h:100,text:"Finish"})')
            third=ev('orivane.api.addObject("ellipse",500,360,{w:180,h:100,text:"Alternative"})')
            ev('orivane.api.select([]);orivane.editor.setTool("connector")')
            drag_world(190,150,590,150)
            edge=ev('orivane.doc.objects().find(o=>o.type==="connector").id')
            assert ev('id=>orivane.doc.get(id).from.id',edge)==left
            assert ev('id=>orivane.doc.get(id).to.id',edge)==right
            ev('id=>{orivane.editor.setTool("select");orivane.api.select([id])}',edge)
            drag_world(500,150,590,410)
            assert ev('id=>orivane.doc.get(id).to.id',edge)==third
            ev('id=>orivane.api.updateObject(id,{x:530})',third)
            assert ev('id=>orivane.doc.get(id).to.id',edge)==third
            action('undo'); action('undo')
            assert ev('id=>orivane.doc.get(id).to.id',edge)==right
            passed('Connected diagram creation, endpoint reconnection and undo')

            ev('orivane.editor.setTool("pen")')
            drag_world(60,330,340,440)
            pen=ev('orivane.doc.objects().find(o=>o.type==="pen")')
            assert len(pen['points'])>=8
            ev('orivane.editor.setTool("select")')
            passed('Pointer-driven freehand strokes and coalesced-event fallback', {'samples':len(pen['points'])})

            card=ev('orivane.api.addObject("card",850,100,{text:"Draft task"})')
            ev('id=>orivane.editCard(orivane.doc.get(id))',card)
            page.locator('#card-text').fill('Ship the prototype')
            page.locator('#card-assignee').fill('Design team')
            page.locator('#card-status').select_option('In progress')
            page.get_by_role('button',name='Save task',exact=True).click()
            assert ev('id=>orivane.doc.get(id).status',card)=='In progress'
            table=ev('orivane.api.addObject("table",850,330,{rows:2,cols:2,cells:[["A","B"],["1","2"]]})')
            ev('id=>orivane.editTable(orivane.doc.get(id))',table)
            page.get_by_label('Row 2, column 2',exact=True).fill('Edited cell')
            page.get_by_role('button',name='Save table',exact=True).click()
            assert ev('id=>orivane.doc.get(id).cells[1][1]',table)=='Edited cell'
            passed('Task fields and editable table cells')

            ev('orivane.openComment({x:270,y:100})')
            page.locator('#comment-text').fill('This discussion is attached to the canvas.')
            page.get_by_role('button',name='Add comment',exact=True).click()
            assert ev('orivane.doc.all().filter(o=>o.type==="comment").length')==1
            action('panel-close')
            action('timer');page.locator('#timer-minutes').fill('1');action('timer-start')
            assert ev('orivane.doc.get("workshop_timer").running') is True
            action('timer-pause');assert ev('orivane.doc.get("workshop_timer").running') is False
            action('panel-close');action('voting');page.locator('#vote-limit').fill('1');action('vote-start')
            ev('([a,b])=>{orivane.castVote(a);orivane.castVote(b)}',[left,right])
            assert ev('orivane.doc.all().filter(o=>o.type==="vote").length')==1
            action('vote-end');action('panel-close')
            passed('Pinned comments, workshop timer and vote allowance UI')

            action('search');page.locator('#board-search').fill('Ship the prototype')
            page.wait_for_timeout(150)
            assert page.locator('#panel').inner_text().count('Ship the prototype')>=1
            action('panel-close')
            ev('orivane.openSettings()')
            page.locator('#setting-dark').check();page.get_by_role('button',name='Done',exact=True).click()
            assert page.locator('body').get_attribute('class')=='dark'
            ev('orivane.toggleTheme()')
            action('minimap');assert page.locator('#minimap-wrap').is_visible()
            passed('Search, dark theme, board preferences and minimap')

            frame=ev('orivane.api.addObject("frame",20,20,{w:1100,h:600,text:"A real presentation"})')
            action('present');assert ev('orivane.state.presenting') is True
            page.keyboard.press('Escape');assert ev('orivane.state.presenting') is False
            passed('Frame presentation and keyboard exit')

            imports=ev('''async()=>{const c=document.createElement('canvas');c.width=16;c.height=16;const x=c.getContext('2d');x.fillStyle='#8661de';x.fillRect(0,0,16,16);const blob=await new Promise(r=>c.toBlob(r));const f=new File([blob],'test.png',{type:'image/png'});await orivane.importFiles([f],{x:750,y:200});return orivane.doc.objects().filter(o=>o.type==='image').length;}''')
            assert imports==1
            exports=ev('''async()=>{const png=await orivane.api.renderExport('png'),svg=await orivane.api.renderExport('svg'),json=JSON.parse(orivane.api.exportJSON());const bytes=new Uint8Array(await png.arrayBuffer());return {pngSize:png.size,pngMagic:[...bytes.slice(0,8)],svgValid:!new DOMParser().parseFromString(svg,'image/svg+xml').querySelector('parsererror'),format:json.format,recordCount:json.records.length};}''')
            assert exports['pngMagic']==[137,80,78,71,13,10,26,10] and exports['svgValid'] and exports['format']=='orivane/2'
            passed('Image import and actual PNG, SVG and editable JSON generation',exports)

            # Local save/read/reopen path uses the application’s volatile storage in
            # injected mode, so this does not claim IndexedDB durability.
            saved=ev('''async()=>{await orivane.saveBoard();const id=orivane.boardId,n=orivane.doc.objects().length;await orivane.newBoard();await orivane.openStoredBoard(id);return {n,restored:orivane.doc.objects().length};}''')
            assert saved['n']==saved['restored']
            passed('Local board serialization and reopening',saved)

            # Renderer workload, not a GPU benchmark or an FPS claim.
            perf=ev('''async()=>{await orivane.newBoard();const changes=[];for(let i=0;i<2000;i++)changes.push({id:'stress_'+i,props:{type:'sticky',x:(i%50)*210,y:Math.floor(i/50)*210,w:170,h:170,text:'Idea '+i,fill:'#fff0a6',fontSize:18}});const t=performance.now();orivane.execute(changes,'Stress fixture');Object.assign(orivane.camera,{x:180,y:200,zoom:1});orivane.invalidate();await new Promise(r=>setTimeout(r,300));return {elapsedIncluding300msWait:performance.now()-t,stats:orivane.renderer.stats};}''')
            assert perf['stats']['total']==2000 and perf['stats']['visible']<200
            passed('Two-thousand-object workload and viewport culling',perf)
            assert not errors, errors
            passed('No uncaught desktop JavaScript errors')

            # Fresh mobile board and actual touch-generated pointer event sequences.
            mobile=browser.new_page(viewport={'width':390,'height':844},is_mobile=True,has_touch=True,device_scale_factor=2)
            mobile.on('pageerror',lambda e:errors.append(str(e)))
            load(mobile)
            assert mobile.evaluate('document.documentElement.scrollWidth <= innerWidth')
            mobile.screenshot(path=str(out/'mobile.png'))
            mobile.locator('[data-action="share"]:visible').first.tap()
            assert mobile.get_by_role('dialog').count()==1
            mobile.locator('[data-action="modal-close"]:visible').tap()
            mobile.evaluate('orivane.editor.setTool("hand")')
            before=mobile.evaluate('({x:orivane.camera.x,y:orivane.camera.y,zoom:orivane.camera.zoom})')
            session=mobile.context.new_cdp_session(mobile)
            session.send('Input.dispatchTouchEvent',{'type':'touchStart','touchPoints':[{'x':130,'y':390,'id':1}]})
            session.send('Input.dispatchTouchEvent',{'type':'touchMove','touchPoints':[{'x':180,'y':450,'id':1}]})
            session.send('Input.dispatchTouchEvent',{'type':'touchEnd','touchPoints':[]})
            after=mobile.evaluate('({x:orivane.camera.x,y:orivane.camera.y,zoom:orivane.camera.zoom})')
            assert abs(after['x']-before['x']-50)<1 and abs(after['y']-before['y']-60)<1
            session.send('Input.dispatchTouchEvent',{'type':'touchStart','touchPoints':[{'x':110,'y':390,'id':1},{'x':230,'y':390,'id':2}]})
            session.send('Input.dispatchTouchEvent',{'type':'touchMove','touchPoints':[{'x':80,'y':390,'id':1},{'x':270,'y':390,'id':2}]})
            session.send('Input.dispatchTouchEvent',{'type':'touchEnd','touchPoints':[]})
            assert mobile.evaluate('orivane.camera.zoom') > after['zoom']*1.3
            passed('Mobile layout, share dialog, touch pan and pinch zoom')
            assert not errors,errors
            passed('No uncaught mobile JavaScript errors')

        except Exception as e:
            page.screenshot(path=str(out/'failure.png'))
            results.append({'test':'suite interrupted','passed':False,'detail':str(e)})
            raise
        finally:
            (out/'browser.json').write_text(json.dumps({'injected':args.injected,'tests':results,'errors':errors},indent=2))
            browser.close()
    print(f'{len(results)} browser checks passed. Artifacts: {out}')

if __name__=='__main__':
    main()
