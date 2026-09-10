#!/usr/bin/env python3
"""Real browser tests for the 0.2 connected edition. No API mocks or polyfills.
Normal-origin mode also verifies browser authentication, live rooms and reload
persistence. --injected respects environments that block all navigation: those
origin-dependent checks are explicitly skipped, not counted as passed.
"""
import argparse, base64, json, os, time, urllib.parse, zlib
from pathlib import Path
from playwright.sync_api import sync_playwright
ROOT=Path(__file__).resolve().parents[1]
PNG='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII='

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--injected',action='store_true');parser.add_argument('--url',default='http://localhost:4173');parser.add_argument('--chromium',default=os.environ.get('CHROMIUM','/usr/bin/chromium'));parser.add_argument('--require-gpu',action='store_true')
    args=parser.parse_args();out=ROOT/'test-results';out.mkdir(exist_ok=True);results=[];errors=[];skips=[]
    def passed(name,detail=None):results.append({'test':name,'passed':True,'detail':detail});print('PASS',name,detail or '',flush=True)
    with sync_playwright() as p:
        browser=p.chromium.launch(executable_path=args.chromium,headless=True,args=['--no-sandbox']);context=browser.new_context(viewport={'width':1600,'height':1000},accept_downloads=True);page=context.new_page();page.set_default_timeout(8000);page.on('pageerror',lambda e:errors.append(str(e)))
        def load(target,url=None):
            if args.injected:target.set_content((ROOT/'dist/Orivane.html').read_text(),wait_until='domcontentloaded')
            else:target.goto(url or args.url)
            target.wait_for_function('window.orivane?.ready === true');target.wait_for_timeout(150)
        def ev(code,arg=None):return page.evaluate(code,arg)
        def opened(tab):ev('(tab)=>orivane.connected.open(tab)',tab)
        def close():ev('orivane.closeModal()')
        def upload(name,data):page.locator('#interchange-file').set_input_files({'name':name,'mimeType':'application/octet-stream','buffer':data.encode()});page.wait_for_selector('#apply-import')
        def downloaded(id):
            with page.expect_download() as got:page.locator('#'+id).click()
            return Path(got.value.path()).read_text()
        try:
            load(page);opened('workspaces');assert page.locator('[data-connected-tab]').count()==6;page.screenshot(path=str(out/'connected-workspace.png'));page.locator('[data-connected-tab="account"]').click()
            if args.injected:assert 'local edition' in page.locator('#connected-body').inner_text();skips.append('Browser account/SSO transport, secure GPU and IndexedDB reload: no navigable secure origin in injected mode')
            else:assert page.locator('#auth-login').count()==1
            passed('Connected workspace navigation, account/setup state and six tool sections');close()
            nid=ev('()=>{const id=orivane.api.addObject("sticky",0,0,{text:"Hello 🌿 team",w:380,h:210,fontSize:27});orivane.api.select([id]);orivane.fitSelection();orivane.editor.editText(orivane.doc.get(id));return id}')
            page.locator('.rich-toolbar [data-mark="bold"]').click();assert ev('id=>orivane.doc.get(id).richText.every(r=>r.marks.bold)',nid)
            page.locator('.rich-toolbar [data-mark="italic"]').click();assert ev('id=>orivane.doc.get(id).richText[0].marks.italic',nid)
            page.locator('.rich-toolbar [data-mark="link"]').click();page.get_by_role('textbox',name='Hyperlink URL').fill('https://example.org/ideas');page.get_by_role('button',name='Apply link',exact=True).click();assert ev('id=>orivane.doc.get(id).richText[0].marks.link',nid)=='https://example.org/ideas'
            page.screenshot(path=str(out/'rich-text.png'));page.locator('.canvas-editor').press('Control+End');page.locator('.rich-toolbar [data-mark="bold"]').click();page.locator('.canvas-editor').press('!');assert ev('id=>orivane.doc.get(id).richText.at(-1).marks.bold',nid) is False
            passed('Real contenteditable toolbar: Unicode, bold, italic, safe link and collapsed-caret formatting')
            ev('id=>{const p=new orivane.doc.constructor("remote_browser");p.merge(orivane.doc.snapshot());const op=p.transact([{id,props:{text:p.get(id).text+" REMOTE"}}]);orivane.doc.apply(op,"remote")}',nid)
            assert 'REMOTE' in page.locator('.canvas-editor').inner_text();page.locator('.canvas-editor').press('Control+z');assert 'REMOTE' in ev('id=>orivane.doc.get(id).text',nid);page.locator('.canvas-editor').press('Control+Enter');passed('Live remote text refresh and selective undo preserve the other author’s characters')
            tid=ev('()=>{const id=orivane.api.addObject("table",0,0,{rows:2,cols:2,cells:[["ab",""],["",""]]});orivane.editTable(orivane.doc.get(id));return id}');cell=page.get_by_role('textbox',name='Row 1, column 1');cell.fill('aLOCALb');assert ev('id=>orivane.doc.get(id).cells[0][0]',tid)=='aLOCALb'
            ev('id=>{const peer=new orivane.doc.constructor("remote_cell");peer.merge(orivane.doc.snapshot());orivane.doc.apply(peer.transact([{id,props:{cells:[[peer.get(id).cells[0][0]+"!",""]]}}]),"remote")}',tid);assert cell.input_value()=='aLOCALb!';page.get_by_role('button',name='Save table',exact=True).click();passed('Table input syncs per keystroke and reflects remote character operations')
            cid=ev('()=>{const id=orivane.api.addObject("card",0,0,{text:"Task"});orivane.editCard(orivane.doc.get(id));return id}');page.locator('#card-text').fill('Live task');assert ev('id=>orivane.doc.get(id).text',cid)=='Live task';page.get_by_role('button',name='Save task',exact=True).click();passed('Task description is live collaborative text, not a deferred whole-field save')
            opened('interchange');before=ev('orivane.doc.objects().length');native={'type':'excalidraw','version':2,'elements':[{'id':'a','type':'rectangle','x':0,'y':0,'width':200,'height':100,'text':'Imported','roughness':1},{'id':'image','type':'image','x':210,'y':0,'width':50,'height':50,'fileId':'asset'}],'files':{'asset':{'dataURL':PNG}}};upload('fixture.excalidraw',json.dumps(native));assert ev('orivane.doc.objects().length')==before;assert 'roughness' in page.locator('#interchange-preview').inner_text();page.locator('#apply-import').click();assert ev('orivane.doc.objects().length')==before+2;ev('orivane.api.undo()');assert ev('orivane.doc.objects().length')==before;ev('orivane.api.redo()');passed('Native Excalidraw file input previews conversion warnings and applies an undoable import')
            opened('interchange');ex=json.loads(downloaded('export-excalidraw'));assert ex['type']=='excalidraw' and ex['files'];drawio=downloaded('export-drawio');assert '<mxGraphModel>' in drawio and 'image=data:image/png,' in drawio and 'image=data%3A' not in drawio;before=ev('orivane.doc.objects().length');upload('roundtrip.drawio',drawio);assert 'editable objects' in page.locator('#interchange-preview').inner_text();page.locator('#apply-import').click();assert ev('orivane.doc.objects().filter(o=>o.type==="image").length')>=2;passed('Actual .excalidraw/.drawio downloads and XML re-import retain embedded raster assets')
            xml='<mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/><mxCell id="a" value="Compressed page" vertex="1" parent="1" style="rounded=1;"><mxGeometry x="10" y="20" width="160" height="90" as="geometry"/></mxCell></root></mxGraphModel>';comp=zlib.compressobj(wbits=-15);payload=base64.b64encode(comp.compress(urllib.parse.quote(xml,safe="~!*'()").encode())+comp.flush()).decode();opened('interchange');upload('compressed.drawio','<mxfile><diagram>'+payload+'</diagram></mxfile>');page.locator('#apply-import').click();assert ev('orivane.doc.objects().some(o=>o.text==="Compressed page")');passed('Compressed diagrams.net page decoded with the browser’s real deflate-raw implementation')
            opened('interchange');page.locator('#interchange-file').set_input_files({'name':'unsafe.xml','mimeType':'application/xml','buffer':b'<!DOCTYPE root [<!ENTITY bad SYSTEM "file:///etc/passwd">]><mxGraphModel>&bad;</mxGraphModel>'});page.wait_for_function('!document.querySelector("#connected-error").hidden');assert 'external entities' in page.locator('#connected-error').inner_text();assert page.locator('#apply-import').count()==0;passed('XML external-entity documents rejected before any mutation')
            opened('diagnostics');page.locator('#diagnostics-run').click();page.wait_for_selector('#diagnostics-export',timeout=30000);report=ev('orivane.connected.report');(out/'environment.json').write_text(json.dumps(report,indent=2));assert not [c for c in report['checks'] if c['status']=='fail'],report
            if args.require_gpu:assert any(c['name']=='Orivane GPU raster/readback' and c['status']=='pass' for c in report['checks']),report
            passed('Environment diagnostics reports actual API availability without claiming skipped checks passed',report['checks']);page.screenshot(path=str(out/'connected-diagnostics.png'));close()
            if not args.injected:
                opened('account');email=f'browser-{time.time_ns()}@example.test';page.locator('#auth-email').fill(email);page.locator('#auth-password').fill('Strong-test-password-123!');page.locator('#auth-name').fill('Browser Test');page.locator('#auth-register').click();page.wait_for_selector('#workspace-create');page.locator('#workspace-name').fill('Browser integration');page.locator('#workspace-create').click();page.wait_for_selector('#workspace-publish');page.screenshot(path=str(out/'connected-account-workspace.png'));page.locator('#workspace-publish').click();page.wait_for_function('orivane.collab.connected===true');room=ev('orivane.collab.room');peer=context.new_page();load(peer,args.url+'/#room='+room);peer.wait_for_function('orivane.collab.connected===true');id=ev('orivane.api.addObject("sticky",0,0,{text:"Browser transport"})');peer.wait_for_function('(id)=>orivane.doc.get(id)?.text==="Browser transport"',arg=id);peer.evaluate('(id)=>orivane.api.updateObject(id,{text:"Browser transport + peer"})',id);page.wait_for_function('(id)=>orivane.doc.get(id)?.text.includes("peer")',arg=id);peer.close();passed('Browser cookie login, private workspace creation and tokenless two-tab HTTP collaboration')
                await_value=ev('async()=>{await orivane.storage.put("settings",{id:"test-reload",value:"durable"});return true}');page.reload();page.wait_for_function('window.orivane?.ready');assert ev('async()=>(await orivane.storage.get("settings","test-reload")).value')=='durable';opened('diagnostics');page.locator('#diagnostics-run').click();page.wait_for_selector('#diagnostics-export',timeout=30000);again=ev('orivane.connected.report');assert any(c['name']=='IndexedDB across navigation' and c['status']=='pass' for c in again['checks']);close();passed('Real IndexedDB settings and diagnostic checkpoint survive navigation')
            else:skips.append('The normal-origin account/collaboration/reload branch is provided but was not executed here')
            ev('orivane.actions.theme()');opened('interchange');page.screenshot(path=str(out/'connected-dark.png'));assert ev('document.documentElement.scrollWidth<=innerWidth');close();passed('Dark connected-tool surfaces stay within the viewport')
            mobile=browser.new_page(viewport={'width':390,'height':844},is_mobile=True,has_touch=True);mobile.on('pageerror',lambda e:errors.append(str(e)));load(mobile);mobile.evaluate('orivane.connected.open("interchange")');assert mobile.evaluate('document.documentElement.scrollWidth<=innerWidth');assert mobile.locator('#interchange-file').is_visible();mobile.screenshot(path=str(out/'connected-mobile.png'));passed('Mobile interchange dialog fits a 390-pixel viewport');assert not errors,errors;passed('No uncaught JavaScript errors in connected desktop/mobile tests')
        except Exception as error:
            results.append({'test':'suite interrupted','passed':False,'detail':str(error)});page.screenshot(path=str(out/'connected-failure.png'));raise
        finally:
            (out/'browser-connected.json').write_text(json.dumps({'injected':args.injected,'tests':results,'skipped':skips,'errors':errors},indent=2));browser.close()
    print(f'{len(results)} connected browser checks passed; {len(skips)} explicit environment limitations.')
if __name__=='__main__':main()
