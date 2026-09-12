import { initI18n } from './i18n.js';
import { bindPlainEditor } from './ui/plain-editor.js';
import { importBoardFile } from './core/interchange.js';
import { ConnectedWorkspace } from './enterprise/workspace.js';
import { BoardDocument, makeObject, uid, clone, FORMAT, validateProps } from './core/model.js';
import { History } from './core/history.js';
import { Camera, unionBounds, contains, bounds, clamp } from './core/geometry.js';
import { BoardStorage, localStore, sessionStore } from './core/storage.js';
import { Collaboration } from './core/collaboration.js';
import { EditorController } from './core/editor.js';
import { BoardRenderer } from './render/renderer.js';
import { createTemplate, templateCatalog } from './core/templates.js';
import { downloadFile, exportScene, exportCSV, thumbnail, importSimpleSVG } from './core/export.js';
import { icon, escapeHTML as esc } from './ui/icons.js';
const $ = selector => document.querySelector(selector);
const palette = ['#fff0a6', '#ffdce3', '#e8ddff', '#dce9ff', '#ddf1e5', '#ffe2bd', '#ffffff', '#ececf2'];
const tools = [['select', 'Select', 'V'], ['hand', 'Pan', 'H'], null, ['sticky', 'Sticky note', 'N'], ['text', 'Text', 'T'], ['shapes', 'Shapes', 'S'], ['connector', 'Connector', 'C'], ['pen', 'Draw', 'P'], ['frame', 'Frame', 'F'], ['comment', 'Comment', 'M'], null, ['image', 'Upload', ''], ['more-tools', 'More tools', '']];
export class OrivaneApp {
    async init() {
        await initI18n();
        this.storage = await new BoardStorage().open();
        this.actor = sessionStore.getItem('orivane-actor') || uid('actor');
        sessionStore.setItem('orivane-actor', this.actor);
        try {
            this.profile = JSON.parse(localStore.getItem('orivane-profile')) || { name: 'You', color: '#896bbd' };
        }
        catch {
            this.profile = { name: 'You', color: '#896bbd' };
        }
        this.camera = new Camera();
        this.state = { selection: new Set(), preview: new Map(), peers: new Map(), tool: 'select', dark: localStore.getItem('orivane-theme') === 'dark', grid: true, snap: false, smartSnap: true, trackpad: false, fill: '#fff0a6', stroke: '#595269', penWidth: 3, route: 'elbow', guides: [], reactions: [], laser: [] };
        try {
            const preferences = JSON.parse(localStore.getItem('orivane-preferences') || '{}');
            for (const key of ['grid', 'snap', 'smartSnap', 'trackpad'])
                if (typeof preferences[key] === 'boolean')
                    this.state[key] = preferences[key];
        }
        catch { }
        document.body.classList.toggle('dark', this.state.dark);
        this.activityLog = [];
        this.actions = this.buildActions();
        this.installUI();
        this.connected = new ConnectedWorkspace(this); await this.connected.init();
        const params = new URLSearchParams(location.hash.slice(1));
        const room = params.get('room');
        const token = params.get('token') || sessionStore.getItem(`orivane-token:${room}`);
        if (room && (token || this.connected.session.user)) {
            if (token) sessionStore.setItem(`orivane-token:${room}`, token);
            await this.loadBoard(`room:${room}`, null, { room, token });
        }
        else {
            const requested = params.get('board') || localStore.getItem('orivane-last-board');
            const found = requested && await this.storage.get('boards', requested);
            await this.loadBoard(found ? requested : uid('board'), found ? null : 'discovery');
        }
        this.workshopInterval = setInterval(() => this.updateWorkshops(), 400);
        this.heartbeat = setInterval(() => this.collab?.presence({ selection: [...this.state.selection], view: this.presenceView(), presenting: !!this.state.presenting }), 5000);
        window.addEventListener('pagehide', () => this.saveBoard());
        window.addEventListener('beforeunload', e => { if (this.collab?.pending.length) {
            e.preventDefault();
            e.returnValue = '';
        } });
        document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden')
            this.saveBoard(); });
        window.orivane = this;
        this.api = { getSnapshot: () => this.doc.snapshot(), getObjects: () => clone(this.doc.objects()), addObject: (type, x, y, props = {}) => { const o = makeObject(type, x, y, props); const { id, ...p } = o; this.execute([{ id, props: p }], `Create ${type}`); return id; }, updateObject: (id, props) => this.execute([{ id, props }], 'Update object'), deleteObject: id => this.execute([{ id, props: { $deleted: true } }], 'Delete object'), select: ids => this.editor.select(ids), undo: () => this.undo(), redo: () => this.redo(), fit: () => this.fit(), createRoom: () => this.createRoom(), insertTemplate: name => this.insertTemplate(name), exportJSON: () => JSON.stringify(this.doc.snapshot()), renderExport: format => exportScene(this.doc, format || 'png') };
        $('#loading').classList.add('hidden');
        this.ready = true;
        return this;
    }
    updateLocation(url) { try { history.replaceState(null, '', url); } catch { /* Opaque/file previews can forbid URL rewriting. */ } }
    get writable() { return !this.collab?.room || ['owner', 'editor'].includes(this.collab.role); }
    get title() { return this.doc?.get('board_meta')?.title || 'Untitled board'; }
    async loadBoard(id, template = null, room = null, snapshot = null) {
        if (this.doc)
            await this.saveBoard();
        this.editor?.destroy();
        this.collab?.destroy();
        this.renderer?.destroy();
        this.unsubDoc?.();
        clearTimeout(this.saveTimer);
        this.closePanel();
        this.closePopup();
        this.state.selection.clear();
        this.state.preview.clear();
        this.state.voting = false;
        this.following = null;
        this.state.peers.clear();
        this.state.presenting = false;
        document.body.classList.remove('presenting');
        this.boardId = id;
        this.activityLog = [];
        const stored = await this.storage.get('boards', id);
        this.doc = new BoardDocument(this.actor);
        if (snapshot)
            this.doc.merge(snapshot);
        else if (stored?.snapshot)
            this.doc.merge(stored.snapshot);
        else if (template) {
            const objects = createTemplate(template);
            this.doc.transact(objects.map(({ id, ...props }) => ({ id, props })), 'seed');
            this.doc.transact([{ id: 'board_meta', props: { type: 'meta', title: template === 'discovery' ? 'Atlas · Product discovery' : templateCatalog.find(t => t.id === template)?.name || 'Untitled board' } }], 'seed');
        }
        else if (!room)
            this.doc.transact([{ id: 'board_meta', props: { type: 'meta', title: 'Untitled board' } }], 'seed');
        this.history = new History(this.doc);
        this.camera = new Camera();
        if (stored?.camera)
            Object.assign(this.camera, stored.camera);
        this.lastThumb = null;
        this.lastThumbTime = 0;
        const oldCanvas = $('#scene');
        oldCanvas.replaceWith(oldCanvas.cloneNode(false));
        this.renderer = new BoardRenderer($('#scene'), $('#interaction'), this.doc, this.camera, this.state);
        await this.renderer.init();
        this.renderer.onRender = stats => { this.updateZoom(); $('#engine-name').textContent = this.renderer.mode; $('#engine-badge').title = `${this.renderer.mode} · ${stats.visible.toLocaleString()} / ${stats.total.toLocaleString()} visible objects · ${stats.instances.toLocaleString()} rendering primitives · ${stats.ms.toFixed(2)} ms CPU frame preparation`; if (this.minimapOpen)
            this.drawMinimap(); };
        this.editor = new EditorController(this);
        this.collab = new Collaboration(this.doc, this.storage, id, this.profile);
        this.collab.onStatus = (status, role) => { this.updateSaveStatus(status); this.selectionChanged(); this.updateParticipants(); };
        this.collab.onPresence = peers => { this.state.peers = peers; this.updateParticipants(); if (this.following) {
            const p = peers.get(this.following);
            if (p?.view) {
                const v = p.view;
                if (Number.isFinite(v.cx)) {
                    this.camera.zoom = v.zoom;
                    this.camera.x = this.renderer.width / 2 - v.cx * v.zoom;
                    this.camera.y = this.renderer.height / 2 - v.cy * v.zoom;
                }
                else
                    Object.assign(this.camera, v);
                this.updateZoom();
            }
        } this.invalidate(); };
        this.collab.onReaction = r => { if (r.actor === this.actor && this.state.reactions.some(q => q.actor === r.actor && q.emoji === r.emoji && Math.abs(q.at - r.at) < 1000))
            return; this.state.reactions.push(r); this.invalidate(); };
        this.collab.onWelcome = () => { if (!stored?.camera && room)
            this.fit(); this.updateTitle(); this.saveBoard(); };
        this.collab.onDenied = () => this.toast('The room link is invalid or was revoked. Your cached copy is not synchronized.');
        this.collab.onRejected = reason => this.toast(`The server rejected a change: ${reason}`);
        if (room) {
            await this.collab.connect(room.room, room.token);
            const info = await this.storage.get('settings', `room:${room.room}`);
            if (info && room.token === info.info.ownerToken)
                this.collab.invites = info.info;
        }
        else
            await this.collab.local();
        this.unsubDoc = this.doc.onChange(e => { this.updateTitle(); this.updateWorkshops(); if (e.op) {
            this.activityLog.unshift({ id: e.op.id, actor: e.op.actor, at: Date.now(), count: e.ids.length, local: e.source === 'local' });
            this.activityLog = this.activityLog.slice(0, 120);
        } for (const id of this.state.selection)
            if (!this.doc.get(id))
                this.state.selection.delete(id); this.selectionChanged(); clearTimeout(this.saveTimer); this.saveTimer = setTimeout(() => this.saveBoard(), 350); this.refreshPanel(); });
        if (!stored?.camera && !room) {
            if (template === 'discovery') {
                if (this.renderer.width < 600) {
                    this.camera.zoom = .53;
                    this.camera.x = 55;
                    this.camera.y = 155;
                }
                else {
                    this.camera.zoom = clamp((this.renderer.width - 210) / 1782, .4, .93);
                    this.camera.x = (this.renderer.width - 1782 * this.camera.zoom) / 2 + 25;
                    this.camera.y = 190;
                }
            }
            else
                this.fit();
        }
        this.updateTitle();
        this.updateToolbar();
        this.selectionChanged();
        this.updateZoom();
        this.updateParticipants();
        this.invalidate();
        localStore.setItem('orivane-last-board', id);
        if (!room)
            this.updateLocation( `${location.pathname}${location.search}#board=${encodeURIComponent(id)}`);
        await this.saveBoard();
    }
    installUI() {
        document.querySelectorAll('[data-icon]').forEach(el => el.innerHTML = icon(el.dataset.icon));
        this.updateToolbar();
        document.addEventListener('click', e => {
            const tool = e.target.closest('[data-tool]');
            if (tool) {
                this.editor?.setTool(tool.dataset.tool);
                return;
            }
            const a = e.target.closest('[data-action]');
            if (a) {
                const action = a.dataset.action;
                const rect = a.getBoundingClientRect();
                this.actionAnchor = { x: rect.left, y: rect.bottom + 8 };
                Promise.resolve(this.dispatch(action, a, e)).catch(err => { console.error(err); this.toast(err.message || 'Unable to complete that action.'); });
                return;
            }
            if (!e.target.closest('#popup'))
                this.closePopup();
        });
        document.addEventListener('change', e => { const key = e.target.dataset.prop; if (key) {
            let value = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
            if (['fontSize', 'strokeWidth', 'w', 'h', 'x', 'y', 'rotation', 'opacity'].includes(key))
                value = Number(value);
            if (['arrowEnd', 'arrowStart', 'dash'].includes(key))
                value = value === 'true';
            this.changeProps({ [key]: value });
        } });
        document.addEventListener('keydown', e => { if (!this.modalOpen)
            return; if (e.key === 'Escape') {
            e.preventDefault();
            this.closeModal();
        } if (e.key === 'Tab') {
            const focusable = [...$('#modal-root').querySelectorAll('button:not(:disabled),input,textarea,select,[tabindex="0"]')].filter(el => el.offsetParent !== null);
            if (!focusable.length)
                return;
            const first = focusable[0], last = focusable.at(-1);
            if (e.shiftKey && document.activeElement === first) {
                e.preventDefault();
                last.focus();
            }
            else if (!e.shiftKey && document.activeElement === last) {
                e.preventDefault();
                first.focus();
            }
        } });
        $('#file-input').addEventListener('change', e => { this.importFiles([...e.target.files], this.editor.center()); e.target.value = ''; });
        $('#minimap').addEventListener('pointerdown', e => { if (!this.minimapTransform)
            return; const r = e.target.getBoundingClientRect(), t = this.minimapTransform, x = (e.clientX - r.left) * 240 / r.width, y = (e.clientY - r.top) * 150 / r.height; const p = { x: (x - t.x) / t.zoom, y: (y - t.y) / t.zoom }; this.camera.x = this.renderer.width / 2 - p.x * this.camera.zoom; this.camera.y = this.renderer.height / 2 - p.y * this.camera.zoom; this.viewChanged(); });
    }
    buildActions() {
        return {
            boards: () => this.openBoards(), 'new-board': () => this.newBoard(), rename: () => this.renameBoard(), 'board-menu': () => this.boardMenu(), templates: () => this.openTemplates(), share: () => this.openShare(), people: () => this.openPeople(), comments: () => this.openComments(), activity: () => this.openActivity(), frames: () => this.openFrames(), timer: () => this.openTimer(), voting: () => this.openVoting(), reactions: () => this.popup(`<div class="reactions">${['❤️', '👏', '🎉', '👍', '🔥', '💡'].map(e => `<button data-action="react:${e}" aria-label="Send ${e}">${e}</button>`).join('')}</div>`), search: () => this.openSearch(), organize: () => this.openOrganize(), present: () => this.startPresenting(), 'present-next': () => this.presentationStep(1), 'present-prev': () => this.presentationStep(-1), 'present-exit': () => this.stopPresenting(), undo: () => this.undo(), redo: () => this.redo(), fit: () => this.fit(), 'fit-selection': () => this.fitSelection(), 'zoom-in': () => this.zoom(1.2), 'zoom-out': () => this.zoom(1 / 1.2), 'zoom-menu': () => this.zoomMenu(), minimap: () => { this.minimapOpen = !this.minimapOpen; $('#minimap-wrap').classList.toggle('hidden', !this.minimapOpen); this.drawMinimap(); }, help: () => this.help(), settings: () => this.openSettings(), theme: () => this.toggleTheme(), 'panel-close': () => this.closePanel(), 'modal-close': () => this.closeModal(), inspector: () => this.openInspector(), copy: () => this.editor.copy(), cut: () => { this.editor.copy(); this.editor.remove(); }, paste: () => this.editor.paste(), duplicate: () => this.editor.duplicate(), delete: () => this.editor.remove(), group: () => this.editor.group(), ungroup: () => this.editor.ungroup(), 'select-all': () => this.editor.select(this.doc.objects().filter(o => o.type !== 'frame').map(o => o.id)), lock: () => this.changeProps({ locked: !this.editor.chosen().every(o => o.locked) }, true), front: () => this.changeProps({ z: Math.max(0, ...this.doc.objects().map(o => o.z || 0)) + 1 }), back: () => this.changeProps({ z: Math.min(0, ...this.doc.objects().map(o => o.z || 0)) - 1 }), bold: () => this.changeProps({ bold: !this.editor.chosen()[0]?.bold }), italic: () => this.changeProps({ italic: !this.editor.chosen()[0]?.italic }), alignment: () => this.alignmentMenu(), colors: () => this.colorMenu(), 'export-json': () => this.exportFile('json'), 'export-png': () => this.exportFile('png'), 'export-svg': () => this.exportFile('svg'), 'export-csv': () => this.exportFile('csv'), import: () => this.chooseFile('import'), upload: () => this.chooseFile('image'), shapes: () => this.shapeMenu(), 'more-tools': () => this.moreTools(), draw: () => this.drawingMenu(), snapshot: () => this.saveVersion(), 'room-create': () => this.createRoom(), 'profile-save': () => this.saveProfile(), 'chat-send': () => this.sendChat(), 'timer-start': () => this.startTimer(), 'timer-pause': () => this.pauseTimer(), 'timer-reset': () => this.resetTimer(), 'vote-start': () => this.startVoting(), 'vote-cast': () => { this.state.voting = true; this.editor.setTool('select'); this.closePanel(); this.toast('Click objects to vote. Click again to remove your vote.'); }, 'vote-end': () => this.endVoting(), 'vote-exit': () => { this.state.voting = false; this.updateWorkshops(); this.closePanel(); }, 'organize-grid': () => this.organize('grid'), 'organize-color': () => this.organize('color'), 'organize-summary': () => this.summarizeNotes(), 'convert-cards': () => this.convertCards(), 'add-mindmap-child': () => this.editor.addMindmapChild(), 'stop-following': () => { this.following = null; this.toast('You are exploring on your own.'); }, 'palette': () => this.commandPalette(), 'export-menu': () => this.exportMenu(), print: () => this.printBoard()
        };
    }
    dispatch(action, el, event) { if (this.actions[action])
        return this.actions[action](el, event); const at = action.indexOf(':'), prefix = at < 0 ? action : action.slice(0, at), value = action.slice(at + 1); if (prefix === 'tool')
        return this.editor.setTool(value); if (prefix === 'template')
        return this.insertTemplate(value); if (prefix === 'template-filter')
        return this.renderTemplates(value); if (prefix === 'open-board')
        return this.openStoredBoard(value); if (prefix === 'delete-board')
        return this.deleteBoard(value); if (prefix === 'frame' || prefix === 'focus')
        return this.focusObject(value); if (prefix === 'align')
        return this.editor.align(value); if (prefix === 'distribute')
        return this.editor.distribute(value); if (prefix === 'color')
        return this.changeProps({ fill: value }); if (prefix === 'react') {
        this.closePopup();
        return this.collab.reaction(value, this.editor.center());
    } if (prefix === 'timer-preset') {
        $('#timer-minutes').value = value;
        return;
    } if (prefix === 'reply')
        return this.replyComment(value); if (prefix === 'resolve')
        return this.resolveComment(value); if (prefix === 'follow') {
        this.following = value;
        this.closePanel();
        this.toast('Following this participant. Open People to stop following.');
        return;
    } if (prefix === 'restore')
        return this.restoreVersion(value); if (prefix === 'copy-link')
        return this.copyInvite(value); if (prefix === 'zoom') {
        this.camera.zoomAt(Number(value) / this.camera.zoom, { x: this.renderer.width / 2, y: this.renderer.height / 2 });
        this.closePopup();
        this.viewChanged();
        return;
    } }
    execute(changes, label = 'Edit') { if (!this.writable) {
        this.toast('This board is view-only.');
        return null;
    } if (!changes.length)
        return null; try {
        const result = this.history.execute(changes, label);
        this.lastCommand = label;
        this.invalidate();
        return result;
    }
    catch (e) {
        this.toast(e.message);
        console.error(e);
        return null;
    } }
    changeProps(props, includeLocked = false) { const objects = this.editor.chosen().filter(o => !o.locked || includeLocked); if (!objects.length) {
        if (props.fill)
            this.state.fill = props.fill;
        if (props.stroke)
            this.state.stroke = props.stroke;
        return;
    } const op = this.execute(objects.map(o => ({ id: o.id, props })), 'Change properties'); this.closePopup(); this.selectionChanged(); return op; }
    undo() { this.editor.endText(); if (!this.writable)
        return; if (!this.history.undo())
        this.toast('Nothing to undo, or those properties were changed by a collaborator.'); this.selectionChanged(); this.invalidate(); }
    redo() { if (!this.writable)
        return; if (!this.history.redo())
        this.toast('Nothing to redo.'); this.selectionChanged(); this.invalidate(); }
    invalidate() { this.renderer?.invalidate(); }
    updateTitle() { $('#board-title').textContent = this.title; document.title = `${this.title} · Orivane`; }
    updateSaveStatus(status) { $('#save-status').textContent = status; $('#save-dot').style.background = /Offline|error|rejected|denied|Session only/.test(status) ? '#d59a4f' : '#65ad8b'; }
    async saveBoard() { if (!this.doc || !this.boardId)
        return; try {
        const board = { id: this.boardId, title: this.title, snapshot: this.doc.snapshot(), camera: { x: this.camera.x, y: this.camera.y, zoom: this.camera.zoom }, updated: Date.now(), room: this.collab?.room || null };
        if (this.renderer && Date.now() - (this.lastThumbTime || 0) > 5000) {
            try {
                this.lastThumb = thumbnail(this.doc);
                this.lastThumbTime = Date.now();
            }
            catch { }
        }
        board.thumbnail = this.lastThumb || null;
        await this.storage.put('boards', board);
        if (!this.collab?.room)
            this.updateSaveStatus(this.storage.mode === 'Memory only' ? 'Session only · export a backup' : 'Saved to this browser');
    }
    catch (e) {
        this.updateSaveStatus('Storage full · export a backup');
        this.toast(`Local save failed: ${e.message}. Export your board as JSON.`);
    } }
    viewChanged() { this.updateZoom(); this.invalidate(); this.collab?.presence({ view: this.presenceView(), presenting: !!this.state.presenting }); clearTimeout(this.viewSave); this.viewSave = setTimeout(() => this.saveBoard(), 1000); }
    presenceView() { const center = this.camera.world({ x: this.renderer.width / 2, y: this.renderer.height / 2 }); return { x: this.camera.x, y: this.camera.y, zoom: this.camera.zoom, cx: center.x, cy: center.y }; }
    updateZoom() { $('#zoom-value').textContent = `${Math.round(this.camera.zoom * 100)}%`; }
    zoom(factor) { this.camera.zoomAt(factor, { x: this.renderer.width / 2, y: this.renderer.height / 2 }); this.viewChanged(); }
    fit() { if (!this.renderer)
        return; this.camera.fit(unionBounds(this.doc.objects()), this.renderer.width, this.renderer.height, this.renderer.width < 600 ? 55 : 115); this.viewChanged(); }
    fitSelection() { const items = this.editor.chosen(); if (items.length) {
        this.camera.fit(unionBounds(items), this.renderer.width, this.renderer.height, 150);
        this.viewChanged();
    }
    else
        this.fit(); }
    focusObject(id) { const o = this.doc.get(id); if (!o)
        return; this.editor.select([id]); this.camera.fit(bounds(o), this.renderer.width, this.renderer.height, this.renderer.width < 600 ? 75 : 160); this.viewChanged(); if (this.renderer.width < 800)
        this.closePanel(); this.closePopup(); }
    updateToolbar() { $('#toolbar').innerHTML = tools.map(t => !t ? '<div class="tool-separator"></div>' : `<button class="tool-button ${this.state?.tool === t[0] || t[0] === 'shapes' && ['rect', 'ellipse', 'diamond', 'triangle'].includes(this.state?.tool) ? 'active' : ''}" ${['shapes', 'more-tools', 'image'].includes(t[0]) ? `data-action="${t[0] === 'image' ? 'upload' : t[0]}"` : `data-tool="${t[0]}"`} title="${t[1]}${t[2] ? ' (' + t[2] + ')' : ''}" aria-label="${t[1]}" ${this.state?.tool === t[0] ? 'aria-pressed="true"' : ''}>${icon(t[0] === 'more-tools' ? 'plus' : t[0])}${t[0] === 'shapes' ? '<span class="tool-extra"></span>' : ''}</button>`).join(''); }
    selectionChanged() {
        if (!this.editor)
            return;
        const objects = this.editor.chosen(), o = objects[0], bar = $('#properties');
        bar.classList.toggle('hidden', !o || !this.writable);
        if (!o)
            return;
        const line = ['pen', 'connector'].includes(o.type);
        const colorProp = o.type === 'text' ? 'color' : line ? 'stroke' : 'fill';
        const color = o[colorProp] && o[colorProp] !== 'transparent' ? o[colorProp] : '#ffffff';
        bar.innerHTML = `${objects.length > 1 ? `<span class="selection-count">${objects.length} selected</span>` : ''}<label class="color-control" title="${line ? 'Stroke' : 'Fill'} color"><input type="color" value="${color}" data-prop="${colorProp}" aria-label="Object color"></label>${line ? `<select data-prop="strokeWidth" aria-label="Stroke width">${[1, 2, 3, 5, 8, 12, 20].map(n => `<option ${o.strokeWidth === n ? 'selected' : ''} value="${n}">${n} px</option>`).join('')}</select>` : `<input type="number" min="6" max="200" value="${o.fontSize || 18}" data-prop="fontSize" aria-label="Font size"><button class="icon-button ${o.bold ? 'active' : ''}" data-action="bold" title="Bold">${icon('bold', 17)}</button><button class="icon-button optional-prop ${o.italic ? 'active' : ''}" data-action="italic" title="Italic">${icon('italic', 17)}</button><select data-prop="align" aria-label="Text alignment">${['left', 'center', 'right'].map(v => `<option value="${v}" ${o.align === v ? 'selected' : ''}>${v[0].toUpperCase() + v.slice(1)}</option>`).join('')}</select>`}<span class="divider"></span>${o.type === 'connector' ? `<select data-prop="route" aria-label="Connector routing">${['straight', 'elbow', 'curve'].map(v => `<option ${o.route === v ? 'selected' : ''}>${v}</option>`).join('')}</select><select data-prop="dash" aria-label="Line style"><option value="false">Solid</option><option value="true" ${o.dash ? 'selected' : ''}>Dashed</option></select>` : ''}${objects.length > 1 ? `<button class="icon-button" data-action="alignment" title="Align and distribute">${icon('align', 18)}</button><button class="icon-button optional-prop" data-action="group" title="Group">${icon('group', 18)}</button>` : ''}<button class="icon-button" data-action="lock" title="${o.locked ? 'Unlock' : 'Lock'}">${icon(o.locked ? 'lock' : 'unlock', 17)}</button><button class="icon-button optional-prop" data-action="duplicate" title="Duplicate">${icon('copy', 17)}</button><button class="icon-button" data-action="inspector" title="All properties">${icon('settings', 17)}</button><button class="icon-button" data-action="delete" title="Delete">${icon('trash', 17)}</button>`;
        $('#accessible-objects').innerHTML = objects.slice(0, 100).map(o => `<div>${esc(o.type)}: ${esc(o.text || 'Untitled')}. Position ${Math.round(o.x)}, ${Math.round(o.y)}.</div>`).join('');
    }
    toast(message) { clearTimeout(this.toastTimer); $('#toast').textContent = message; $('#toast').classList.add('show'); this.toastTimer = setTimeout(() => $('#toast').classList.remove('show'), 4200); }
    popup(html, x = this.actionAnchor?.x || 80, y = this.actionAnchor?.y || 170) { const el = $('#popup'); el.innerHTML = html; el.classList.remove('hidden'); const rect = el.getBoundingClientRect(); el.style.left = Math.max(8, Math.min(innerWidth - rect.width - 8, x)) + 'px'; el.style.top = Math.max(8, Math.min(innerHeight - rect.height - 8, y)) + 'px'; }
    closePopup() { $('#popup')?.classList.add('hidden'); }
    menu(items, x, y) { this.popup(items.map(it => it ? `<button class="menu-item ${it.danger ? 'danger' : ''}" data-action="${esc(it.action)}">${icon(it.icon || 'rect', 17)}<span>${esc(it.label)}</span>${it.key ? `<kbd>${esc(it.key)}</kbd>` : ''}</button>` : '<div class="menu-separator"></div>').join(''), x, y); }
    modal(title, content, buttons = [], wide = false) { this.modalCleanup?.(); this.modalCleanup = null; this.editor?.endText(); this.closePopup(); this.previousFocus = document.activeElement; this.modalOpen = true; $('#modal-root').innerHTML = `<div class="modal-backdrop"><section class="modal ${wide ? 'wide' : ''}" role="dialog" aria-modal="true" aria-label="${esc(title)}"><div class="modal-head"><h2>${esc(title)}</h2><button class="icon-button" data-action="modal-close" aria-label="Close dialog">${icon('close')}</button></div><div class="modal-body">${content}</div>${buttons.length ? `<div class="modal-footer">${buttons.map((b, i) => `<button class="${b.primary ? 'primary-button' : 'secondary-button'}" data-modal-button="${i}">${esc(b.label)}</button>`).join('')}</div>` : ''}</section></div>`; $('#modal-root').querySelector('.modal-backdrop').addEventListener('click', e => { if (e.target.classList.contains('modal-backdrop'))
        this.closeModal(); }); $('#modal-root').querySelectorAll('[data-modal-button]').forEach(el => el.addEventListener('click', async () => { try {
        await buttons[Number(el.dataset.modalButton)].run();
    }
    catch (e) {
        console.error(e);
        this.toast(e.message);
    } })); setTimeout(() => $('#modal-root').querySelector('input,textarea,button')?.focus(), 30); }
    closeModal() { if (!this.modalOpen)
        return; this.modalCleanup?.(); this.modalCleanup = null; this.modalOpen = false; $('#modal-root').innerHTML = ''; if (this.previousFocus?.isConnected)
        this.previousFocus.focus({ preventScroll: true }); }
    inputDialog(title, label, value, run) { this.modal(title, `<label class="field-label">${esc(label)}</label><input id="dialog-value" type="text" value="${esc(value)}" maxlength="200">`, [{ label: 'Cancel', run: () => this.closeModal() }, { label: 'Save', primary: true, run: () => { const value = $('#dialog-value').value.trim(); if (!value)
                return; this.closeModal(); return run(value); } }]); setTimeout(() => $('#dialog-value')?.select(), 45); }
    confirm(title, message, run) { this.modal(title, `<p class="modal-subtitle">${esc(message)}</p>`, [{ label: 'Cancel', run: () => this.closeModal() }, { label: 'Continue', primary: true, run: () => { this.closeModal(); return run(); } }]); }
    panel(title, body, footer = '', type = 'custom') { this.panelType = type; $('#panel').innerHTML = `<div class="panel-head"><h2>${esc(title)}</h2><button class="icon-button" data-action="panel-close" aria-label="Close panel">${icon('close')}</button></div><div class="panel-body">${body}</div>${footer ? `<div class="panel-footer">${footer}</div>` : ''}`; $('#panel').classList.remove('hidden'); }
    closePanel() { this.panelType = null; $('#panel')?.classList.add('hidden'); }
    refreshPanel() { if (document.activeElement?.closest('#panel') && this.editor.isTyping(document.activeElement))
        return; if (this.panelType === 'comments')
        this.openComments(); if (this.panelType === 'voting')
        this.openVoting(); if (this.panelType === 'frames')
        this.openFrames(); if (this.panelType === 'activity')
        this.openActivity(); if (this.panelType === 'people')
        this.openPeople(); }
    boardMenu() { this.menu([{ action: 'boards', label: 'Back to workspace', icon: 'home' }, { action: 'rename', label: 'Rename board', icon: 'pen' }, null, { action: 'templates', label: 'Insert a template', icon: 'template' }, { action: 'import', label: 'Import board or content', icon: 'upload', key: '⌘O' }, { action: 'export-menu', label: 'Export board', icon: 'download', key: '⌘S' }, { action: 'snapshot', label: 'Save a version', icon: 'history' }, null, { action: 'search', label: 'Search this board', icon: 'search', key: '⌘F' }, { action: 'palette', label: 'Command palette', icon: 'keyboard', key: '⌘K' }, null, { action: 'settings', label: 'Board preferences', icon: 'settings' }, { action: 'theme', label: this.state.dark ? 'Switch to light' : 'Switch to dark', icon: this.state.dark ? 'sun' : 'moon' }, { action: 'help', label: 'Help & shortcuts', icon: 'help' }]); }
    contextMenu(x, y) { const selected = this.state.selection.size; const list = selected ? [{ action: 'copy', label: 'Copy', icon: 'copy', key: '⌘C' }, { action: 'cut', label: 'Cut', icon: 'pen', key: '⌘X' }, { action: 'duplicate', label: 'Duplicate', icon: 'copy', key: '⌘D' }, null, { action: 'group', label: 'Group selection', icon: 'group', key: '⌘G' }, { action: 'ungroup', label: 'Ungroup', icon: 'group', key: '⇧⌘G' }, { action: 'alignment', label: 'Align & distribute', icon: 'align' }, null, { action: 'front', label: 'Bring to front', icon: 'layers' }, { action: 'back', label: 'Send to back', icon: 'layers' }, { action: 'lock', label: 'Lock / unlock', icon: 'lock' }, { action: 'inspector', label: 'Object properties', icon: 'settings' }, null, { action: 'delete', label: 'Delete', icon: 'trash', key: '⌫', danger: true }] : [{ action: 'paste', label: 'Paste', icon: 'copy', key: '⌘V' }, { action: 'tool:sticky', label: 'Add a sticky note', icon: 'sticky', key: 'N' }, { action: 'tool:comment', label: 'Add a comment', icon: 'comment', key: 'M' }, { action: 'templates', label: 'Insert template', icon: 'template' }, null, { action: 'select-all', label: 'Select all', icon: 'select', key: '⌘A' }, { action: 'fit', label: 'Fit board', icon: 'fit', key: '⇧1' }, { action: 'settings', label: 'Board preferences', icon: 'settings' }]; this.menu(list, x, y); }
    shapeMenu() { this.menu(['rect', 'ellipse', 'diamond', 'triangle'].map(t => ({ action: `tool:${t}`, label: ({ rect: 'Rectangle', ellipse: 'Ellipse', diamond: 'Diamond', triangle: 'Triangle' })[t], icon: t }))); }
    moreTools() { this.menu([{ action: 'tool:card', label: 'Task card', icon: 'card' }, { action: 'tool:table', label: 'Table', icon: 'table' }, { action: 'tool:mindmap', label: 'Mind-map node', icon: 'mindmap' }, { action: 'add-mindmap-child', label: 'Add connected idea', icon: 'mindmap', key: 'Tab' }, null, { action: 'tool:line', label: 'Straight line', icon: 'line', key: 'L' }, { action: 'tool:highlighter', label: 'Highlighter', icon: 'highlighter' }, { action: 'tool:eraser', label: 'Eraser', icon: 'eraser', key: 'E' }, { action: 'tool:laser', label: 'Laser pointer (local)', icon: 'laser' }, null, { action: 'draw', label: 'Pen settings', icon: 'pen' }, { action: 'upload', label: 'Upload an image', icon: 'image' }, { action: 'import', label: 'Import JSON, SVG or text', icon: 'upload' }]); }
    drawingMenu() { this.modal('Make your mark', `<p class="modal-subtitle">Pen and highlighter marks are editable, pressure-sensitive strokes.</p><label class="field-label">Ink color</label><input id="pen-color" type="color" value="${this.state.stroke}" style="width:100%;height:42px;border:0"><label class="field-label">Pen width</label><input id="pen-width" type="number" min="1" max="50" value="${this.state.penWidth}"><div class="notice">Use <strong>P</strong> for the pen or choose Highlighter from More tools. Erase with <strong>E</strong>.</div>`, [{ label: 'Cancel', run: () => this.closeModal() }, { label: 'Use pen', primary: true, run: () => { this.state.stroke = $('#pen-color').value; this.state.penWidth = clamp(Number($('#pen-width').value), 1, 50); this.closeModal(); this.editor.setTool('pen'); } }]); }
    colorMenu() { this.popup(`<div class="color-swatches">${palette.map(c => `<button class="color-swatch" style="background:${c}" data-action="color:${c}" title="${c}" aria-label="Set color ${c}"></button>`).join('')}</div>`); }
    alignmentMenu() { this.menu([{ action: 'align:left', label: 'Align left edges', icon: 'align' }, { action: 'align:center', label: 'Align horizontal centers', icon: 'align' }, { action: 'align:right', label: 'Align right edges', icon: 'align' }, null, { action: 'align:top', label: 'Align top edges', icon: 'align' }, { action: 'align:middle', label: 'Align vertical centers', icon: 'align' }, { action: 'align:bottom', label: 'Align bottom edges', icon: 'align' }, null, { action: 'distribute:x', label: 'Distribute horizontally', icon: 'distribute' }, { action: 'distribute:y', label: 'Distribute vertically', icon: 'distribute' }]); }
    zoomMenu() { this.menu([{ action: 'zoom:0.25', label: '25%', icon: 'search' }, { action: 'zoom:0.5', label: '50%', icon: 'search' }, { action: 'zoom:1', label: '100%', icon: 'search' }, { action: 'zoom:2', label: '200%', icon: 'search' }, null, { action: 'fit', label: 'Fit all content', icon: 'fit', key: '⇧1' }, { action: 'fit-selection', label: 'Zoom to selection', icon: 'fit', key: '⇧2' }]); }
    renameBoard() { if (!this.writable)
        return this.toast('An editor link is required to rename the board.'); this.inputDialog('Give this space a name', 'Board name', this.title, value => this.execute([{ id: 'board_meta', props: { type: 'meta', title: value } }], 'Rename board')); }
    async newBoard(template = null) { this.closeModal(); const id = uid('board'); await this.loadBoard(id, template); if (!template) {
        this.camera.x = this.renderer.width / 2;
        this.camera.y = this.renderer.height / 2;
        this.viewChanged();
        this.toast('Your board is ready. Double-click anywhere to add a note.');
    } }
    async openStoredBoard(id) { const board = await this.storage.get('boards', id); if (!board)
        return; this.closeModal(); let room = null; if (board.room) {
        const token = sessionStore.getItem(`orivane-token:${board.room}`);
        if (token || this.connected?.session.user)
            room = { room: board.room, token: token || '' };
        else {
            this.toast('Opening a local copy. Use the original share link to rejoin the live room.');
            return this.loadBoard(uid('board'), null, null, board.snapshot);
        }
    } await this.loadBoard(id, null, room); }
    async openBoards() { await this.saveBoard(); const boards = (await this.storage.all('boards')).sort((a, b) => b.updated - a.updated); this.modal('A space for every idea.', `<div class="dashboard-banner"><div><h3>Think better, together.</h3><p>Bring the messy beginnings, the unexpected connections,<br>and the big plans. There is room for all of it.</p></div><button class="primary-button" data-action="templates">${icon('template', 18)} Explore templates</button></div><div style="display:flex;align-items:center;justify-content:space-between;margin:8px 0 17px"><strong style="font-size:14px">Your boards</strong><span class="muted">${boards.length} saved in this browser</span></div><div class="boards-grid"><button class="new-board-tile" data-action="new-board">${icon('plus', 30)}<strong>Create a new board</strong></button>${boards.map(b => `<article class="board-card"><button data-action="open-board:${esc(b.id)}"><div class="board-thumbnail">${b.thumbnail ? `<img alt="Board thumbnail" src="${b.thumbnail}">` : icon('frame', 50)}</div><div class="board-card-info"><strong>${esc(b.title)}</strong><small>${b.room ? 'Live room · ' : 'Local board · '}${new Date(b.updated).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</small></div></button><button class="icon-button delete-board" data-action="delete-board:${esc(b.id)}" title="Remove saved board" aria-label="Remove ${esc(b.title)}">${icon('trash', 15)}</button></article>`).join('')}</div><p class="muted" style="margin:22px 0 0">Boards are local-first. Create a live room from Share to work across devices. Export JSON to keep an independent backup.</p>`, [], true); }
    deleteBoard(id) { this.confirm('Remove this saved board?', 'This removes the browser copy, not a live room on the server. Export a JSON backup first to keep it.', async () => { await this.storage.delete('boards', id); if (id === this.boardId) {
        this.boardId = null;
        await this.newBoard();
    } await this.openBoards(); }); }
    openTemplates() { this.modal('Good things start with a little space.', `<p class="modal-subtitle">Pick a starting point. Every note, shape, and connection is yours to change.</p><div class="template-filters">${['All', 'Featured', 'Ideation', 'Planning', 'Workshops', 'Diagramming', 'Research', 'Design', 'Strategy'].map((c, i) => `<button class="filter-chip ${i === 0 ? 'active' : ''}" data-action="template-filter:${c}">${c}</button>`).join('')}</div><div id="template-grid" class="template-grid"></div>`, [], true); this.renderTemplates('All'); }
    renderTemplates(category) { const grid = $('#template-grid'); if (!grid)
        return; $('#modal-root').querySelectorAll('.filter-chip').forEach(el => el.classList.toggle('active', el.dataset.action === `template-filter:${category}`)); grid.innerHTML = templateCatalog.filter(t => category === 'All' || t.category === category).map((t, index) => `<button class="template-card" data-action="template:${t.id}"><div class="template-preview">${this.templatePreview(t.id, t.color, index)}</div><div class="template-info"><span>${t.category}</span><strong>${esc(t.name)}</strong><p>${esc(t.desc)}</p></div></button>`).join(''); }
    templatePreview(id, color, index) { const objects = createTemplate(id), b = unionBounds(objects), pad = 20; const elements = objects.filter(o => o.type !== 'connector').slice(0, 70).map(o => { if (o.type === 'text')
        return `<rect x="${o.x}" y="${o.y}" width="${Math.min(o.w * .75, o.text.length * (o.fontSize || 18) * .45)}" height="${(o.fontSize || 18) * .5}" rx="3" fill="#3d365c" opacity=".5"/>`; if (o.type === 'table') {
        let s = '';
        for (let r = 0; r < (o.rows || 3); r++)
            for (let c = 0; c < (o.cols || 3); c++)
                s += `<rect x="${o.x + c * o.w / o.cols}" y="${o.y + r * o.h / o.rows}" width="${o.w / o.cols - 4}" height="${o.h / o.rows - 4}" fill="${r === 0 ? color : '#ffffff'}"/>`;
        return s;
    } return `<rect x="${o.x}" y="${o.y}" width="${o.w}" height="${o.h}" rx="${o.radius || 3}" fill="${o.fill || color}" stroke="#c6c1d6" stroke-width="2"/>${o.text && o.type !== 'frame' ? `<rect x="${o.x + o.w * .13}" y="${o.y + o.h * .4}" width="${o.w * .68}" height="${Math.min(o.h * .09, 12)}" rx="2" fill="#655572" opacity=".32"/>` : ''}`; }); return `<svg viewBox="${b.x - pad} ${b.y - pad} ${b.w + pad * 2} ${b.h + pad * 2}" aria-hidden="true">${elements.join('')}</svg>`; }
    insertTemplate(name) { if (!this.writable)
        return this.toast('You need an editor link to insert content.'); this.closeModal(); const point = this.editor.center(), objects = createTemplate(name); const b = unionBounds(objects), offset = { x: point.x - b.w / 2, y: point.y - b.h / 2 }; for (const o of objects) {
        o.x += offset.x;
        o.y += offset.y;
        o.z = Date.now() + o.z;
    } this.execute(objects.map(({ id, ...props }) => ({ id, props })), `Insert ${name} template`); this.editor.select(objects.filter(o => o.type === 'frame').map(o => o.id)); this.camera.fit(unionBounds(objects), this.renderer.width, this.renderer.height, this.renderer.width < 600 ? 65 : 135); this.viewChanged(); this.toast('Template added. Everything on it is editable.'); return objects.map(o => o.id); }
    openInspector() { const o = this.editor.chosen()[0]; if (!o)
        return; this.panel(this.state.selection.size > 1 ? `${this.state.selection.size} selected` : 'Object properties', `<p class="muted">${esc(o.type)} · Changes apply to the current selection.</p><div class="form-grid">${[['x', 'X position'], ['y', 'Y position'], ['w', 'Width'], ['h', 'Height'], ['rotation', 'Rotation (degrees)'], ['opacity', 'Opacity (0–1)']].filter(([k]) => !(['pen', 'connector'].includes(o.type) && ['w', 'h', 'rotation'].includes(k))).map(([k, label]) => `<label><span class="field-label">${label}</span><input type="number" data-prop="${k}" value="${Number(o[k] ?? (k === 'opacity' ? 1 : 0)).toFixed(k === 'opacity' ? 2 : 1)}" step="${k === 'opacity' ? '.05' : '1'}"></label>`).join('')}<label><span class="field-label">Stroke color</span><input type="color" data-prop="stroke" value="${o.stroke && o.stroke !== 'transparent' ? o.stroke : '#9ca3b8'}" style="width:100%;height:36px;border:0"></label><label><span class="field-label">Stroke width</span><input type="number" data-prop="strokeWidth" value="${o.strokeWidth || 1}" min="0" max="100"></label><label><span class="field-label">Text color</span><input type="color" data-prop="color" value="${o.color || '#25283d'}" style="width:100%;height:36px;border:0"></label><label><span class="field-label">Corner radius</span><input id="corner-radius" type="number" value="${o.radius || 0}" min="0" max="500"></label></div>${o.type === 'connector' ? `<label class="field-label">End arrow</label><select data-prop="arrowEnd"><option value="true" ${o.arrowEnd !== false ? 'selected' : ''}>Arrow</option><option value="false" ${o.arrowEnd === false ? 'selected' : ''}>None</option></select><label class="field-label">Start arrow</label><select data-prop="arrowStart"><option value="false">None</option><option value="true" ${o.arrowStart ? 'selected' : ''}>Arrow</option></select>` : ''}<div class="notice">${o.type === 'connector' ? 'Drag an endpoint to reconnect or detach it. Choose straight, elbow, or curved routing in the toolbar.' : o.type === 'pen' ? 'Drag to move this stroke. Change its ink, thickness, or opacity, or use the eraser to remove it.' : 'Drag the eight grips to resize. The circular handle rotates. Hold Shift to constrain proportions or rotation.'}</div>`, `<button class="secondary-button" data-action="front">Bring to front</button><button class="secondary-button" data-action="back">Send to back</button>`, 'inspector'); $('#corner-radius')?.addEventListener('change', e => this.changeProps({ radius: clamp(Number(e.target.value), 0, 500) })); }
    openSearch() { this.panel('Find a little clarity', `<input id="board-search" type="search" placeholder="Search notes, text, and tasks…" aria-label="Search board content"><div id="search-results"><div class="empty-state">${icon('search', 32)}Type a word to find it on this board.</div></div>`, '', 'search'); const input = $('#board-search'); input.focus(); input.addEventListener('input', () => { const query = input.value.trim().toLowerCase(); const results = query ? this.doc.objects().filter(o => [o.text, o.tag, o.assignee, o.cells?.flat().join(' ')].some(t => String(t || '').toLowerCase().includes(query))).slice(0, 150) : []; $('#search-results').innerHTML = results.length ? `<p class="muted">${results.length} matches</p>${results.map(o => `<button class="search-result" data-action="focus:${o.id}"><span class="result-swatch" style="background:${o.fill && o.fill !== 'transparent' ? o.fill : '#f1edf8'}"></span><span class="result-text">${esc(o.text || o.cells?.flat().join(' · ') || 'Untitled')}<span class="result-type">${o.type}</span></span></button>`).join('')}` : `<div class="empty-state">${query ? 'No matching objects. Try another word.' : 'Type a word to get started.'}</div>`; }); }
    commandPalette() { const commands = [['tool:sticky', 'Create a sticky note', 'N'], ['tool:text', 'Create text', 'T'], ['tool:connector', 'Draw a connector', 'C'], ['tool:frame', 'Create a frame', 'F'], ['tool:card', 'Create a task card', ''], ['tool:table', 'Create a table', ''], ['workspace', 'Open connected workspaces', ''], ['ai-assistant', 'AI assistant', ''], ['integrations', 'External connections', ''], ['interchange', 'Import and export native board formats', ''], ['diagnostics', 'Verify rendering and storage', ''], ['server-versions', 'Shared board versions', ''], ['account', 'Account and single sign-on', ''], ['templates', 'Insert template', ''], ['organize', 'Organize ideas', ''], ['share', 'Share this board', ''], ['timer', 'Open timer', ''], ['voting', 'Start a vote', ''], ['present', 'Present frames', ''], ['search', 'Search board', '⌘F'], ['fit', 'Fit board', '⇧1'], ['export-json', 'Export JSON backup', '⌘S'], ['export-png', 'Export PNG image', ''], ['theme', 'Switch color theme', ''], ['settings', 'Board preferences', '']]; this.modal('What would you like to do?', `<input id="command-search" type="search" placeholder="Search commands…" aria-label="Search commands"><div id="command-results" style="margin-top:15px"></div>`); const render = q => { $('#command-results').innerHTML = commands.filter(c => c[1].toLowerCase().includes(q)).map(c => `<button class="menu-item" data-command="${c[0]}">${icon('chevron', 16)}<span>${c[1]}</span><kbd>${c[2]}</kbd></button>`).join(''); $('#command-results').querySelectorAll('[data-command]').forEach(el => el.onclick = () => { this.closeModal(); this.dispatch(el.dataset.command); }); }; render(''); $('#command-search').addEventListener('input', e => render(e.target.value.toLowerCase())); }
    openSettings() { this.modal('Make this space yours', `<p class="modal-subtitle">An infinite canvas, with a little control over how it feels.</p><label class="toggle-row">Show the dot grid<input id="setting-grid" type="checkbox" ${this.state.grid ? 'checked' : ''}></label><label class="toggle-row">Snap to 16-unit grid<input id="setting-snap" type="checkbox" ${this.state.snap ? 'checked' : ''}></label><label class="toggle-row">Smart alignment guides<input id="setting-smart" type="checkbox" ${this.state.smartSnap ? 'checked' : ''}></label><label class="toggle-row">Trackpad mode (scroll pans; pinch zooms)<input id="setting-trackpad" type="checkbox" ${this.state.trackpad ? 'checked' : ''}></label><label class="toggle-row">Dark workspace<input id="setting-dark" type="checkbox" ${this.state.dark ? 'checked' : ''}></label><div class="notice"><strong>${this.renderer.mode}</strong> is active. Coordinates extend to ±10 million units; zoom ranges from 3.5% to 800%. WebGPU falls back to Canvas 2D when unavailable. Text is raster-cached and GPU-composited, not drawn as individual DOM elements.</div>`, [{ label: 'Done', primary: true, run: () => { this.state.grid = $('#setting-grid').checked; this.state.snap = $('#setting-snap').checked; this.state.smartSnap = $('#setting-smart').checked; this.state.trackpad = $('#setting-trackpad').checked; this.state.dark = $('#setting-dark').checked; document.body.classList.toggle('dark', this.state.dark); localStore.setItem('orivane-theme', this.state.dark ? 'dark' : 'light'); localStore.setItem('orivane-preferences', JSON.stringify(Object.fromEntries(['grid', 'snap', 'smartSnap', 'trackpad'].map(k => [k, this.state[k]])))); this.closeModal(); this.invalidate(); } }]); }
    toggleTheme() { this.state.dark = !this.state.dark; document.body.classList.toggle('dark', this.state.dark); localStore.setItem('orivane-theme', this.state.dark ? 'dark' : 'light'); this.closePopup(); this.invalidate(); }
    openOrganize() { this.panel('A little order. More possibility.', `<p class="muted">Select notes or objects, then choose how to organize them. These tools run locally and do not send your content to an AI service.</p><button class="frame-row" data-action="organize-grid">${icon('grid', 23)}<span><strong>Tidy into a grid</strong><br>Consistent spacing, without the fiddling.</span></button><button class="frame-row" data-action="organize-color">${icon('sticky', 23)}<span><strong>Cluster by color</strong><br>Bring related notes a little closer.</span></button><button class="frame-row" data-action="organize-summary">${icon('text', 23)}<span><strong>Collect selected text</strong><br>Create a local, verbatim summary card.</span></button><button class="frame-row" data-action="convert-cards">${icon('card', 23)}<span><strong>Turn notes into tasks</strong><br>Keep the idea, add an owner and a tag.</span></button><div class="notice">No notes selected? Tidy uses all unlocked sticky notes on the board.</div>`, '', 'organize'); }
    organize(mode) { let objects = this.editor.chosen().filter(o => !o.locked && !['frame', 'connector', 'pen'].includes(o.type)); if (!objects.length)
        objects = this.doc.objects().filter(o => o.type === 'sticky' && !o.locked); if (!objects.length)
        return this.toast('Add a few notes first.'); const b = unionBounds(objects), groups = mode === 'color' ? [...new Set(objects.map(o => o.fill))].map(color => objects.filter(o => o.fill === color)) : [objects]; const changes = []; let groupX = b.x; for (const group of groups) {
        const columns = Math.ceil(Math.sqrt(group.length)), w = Math.max(...group.map(o => o.w)) + 28, h = Math.max(...group.map(o => o.h)) + 28;
        group.forEach((o, i) => changes.push({ id: o.id, props: { x: groupX + (i % columns) * w, y: b.y + Math.floor(i / columns) * h, rotation: 0 } }));
        groupX += columns * w + 70;
    } this.execute(changes, 'Organize objects'); this.editor.select(objects.map(o => o.id)); this.toast(`${objects.length} ideas, a little more organized.`); }
    summarizeNotes() { const selected = this.editor.chosen().filter(o => o.text); if (!selected.length)
        return this.toast('Select notes or text to collect.'); const b = unionBounds(selected), text = selected.map(o => `• ${o.text}`).join('\n\n').slice(0, 39000), o = makeObject('sticky', b.x + b.w + 60, b.y, { w: 380, h: Math.min(2500, Math.max(250, selected.length * 95)), text, fill: '#e8ddff', fontSize: 18, align: 'left' }); const { id, ...props } = o; this.execute([{ id, props }], 'Collect selected text'); this.editor.select([id]); this.toast('Created a verbatim collection, not an AI-generated summary.'); }
    convertCards() { const objects = this.editor.chosen().filter(o => o.type === 'sticky' && !o.locked); if (!objects.length)
        return this.toast('Select the sticky notes you want to turn into tasks.'); this.execute(objects.map(o => ({ id: o.id, props: { type: 'card', fill: '#ffffff', stroke: '#dfe2eb', w: 240, h: 155, tag: 'TASK', assignee: 'Unassigned', align: 'left', radius: 10 } })), 'Convert notes to tasks'); this.selectionChanged(); }
    updateParticipants() { if (!this.collab)
        return; const peers = [...this.state.peers.values()]; $('#participants').innerHTML = `<button class="avatar" data-action="people" title="${esc(this.profile.name)} (you)" style="background:${this.profile.color}22;color:${this.profile.color}">${esc(this.profile.name.slice(0, 2).toUpperCase())}</button>${peers.slice(0, 3).map(p => `<button class="avatar" data-action="people" style="background:${p.color}22;color:${p.color}" title="${esc(p.name)}">${esc(p.name.slice(0, 2).toUpperCase())}</button>`).join('')}${peers.length > 3 ? `<button class="avatar" data-action="people">+${peers.length - 3}</button>` : ''}`; }
    async createRoom() { if (this.creatingRoom)
        return; if (this.collab.room)
        return this.collab.invites; if (!this.writable)
        return; this.creatingRoom = true; try {
        this.toast('Creating your live room…');
        const info = await this.collab.create();
        this.boardId = `room:${info.id}`;
        sessionStore.setItem(`orivane-token:${info.id}`, info.ownerToken);
        await this.storage.put('settings', { id: `room:${info.id}`, info });
        this.updateLocation( `${location.pathname}${location.search}#room=${info.id}&token=${info.ownerToken}`);
        await this.saveBoard();
        this.toast('Live room created. Share an editor or viewer link to invite your team.');
        if (this.modalOpen)
            this.openShare();
        return info;
    }
    catch (e) {
        this.toast(e.message);
        throw e;
    }
    finally {
        this.creatingRoom = false;
    } }
    inviteLink(role) { const info = this.collab.invites; const token = role === 'owner' ? this.collab.token : info?.[`${role}Token`]; if (!token)
        return ''; const url = new URL(location.href); url.hash = `room=${this.collab.room}&token=${token}`; return url.href; }
    async copyInvite(role) { const link = this.inviteLink(role); if (!link)
        return this.toast('The owner needs to generate a new invitation link.'); try {
        await navigator.clipboard.writeText(link);
        this.toast(`${role === 'viewer' ? 'View-only' : 'Editor'} invitation copied.`);
    }
    catch {
        const el = $(`#share-${role}`);
        el?.focus();
        el?.select();
        this.toast('Select and copy the invitation link shown in the dialog.');
    } }
    openShare() {
        const live = !!this.collab?.room, owner = this.collab?.role === 'owner' || !!this.collab?.invites?.ownerToken && this.collab.token === this.collab.invites.ownerToken;
        this.modal('Good ideas deserve company.', `<p class="modal-subtitle">Bring your team into the same space. Think out loud, move things around, and find a shared direction.</p><div class="share-hero">${icon('people', 38)}<div><strong>${live ? 'A live space for your team' : 'Make this board a shared space'}</strong><small>${live ? 'Changes, cursors, comments, and workshops synchronize across connected devices.' : 'Your board is saved locally. Start a live room with the included server to collaborate across devices.'}</small></div></div>${live ? `<div class="panel-row"><div><strong>${esc(this.title)}</strong><small>${esc(this.collab.status)}</small></div><span class="permission-badge">${esc(this.collab.role)}</span></div>${owner ? ['editor', 'viewer'].map(role => `<label class="field-label">${role === 'editor' ? 'Can edit and collaborate' : 'Can view only'}</label><div class="share-line"><input id="share-${role}" type="text" readonly value="${esc(this.inviteLink(role))}" aria-label="${role} invitation link"><button class="secondary-button" data-action="copy-link:${role}">${icon('copy', 15)} Copy link</button></div>`).join('') : `<div class="notice">You joined with ${this.collab.role === 'viewer' ? 'a view-only' : 'an editor'} link. Ask the owner to create or rotate invitations.</div>`}<div class="notice"><strong>Invitation links grant access.</strong> Anyone with an editor link can modify the room. Do not share your owner link. The server enforces viewer permissions. Use HTTPS when deploying beyond localhost.</div>` : `<div class="notice"><strong>Local board:</strong> changes save to this browser. Other tabs on the same origin can synchronize the same board. Cross-device collaboration needs the bundled Node server, not just a static web host.</div><button class="primary-button" data-action="room-create" style="width:100%">${icon('share', 18)} Create a live room</button><p class="muted" style="margin-bottom:0">Run <code>npm start</code> in the source folder. No package installation or external service is required.</p>`}`, live && owner ? [{ label: 'Revoke & regenerate invite links', run: () => this.confirm('Replace all invitation links?', 'Current editor and viewer links will stop working and their sessions will disconnect. The owner link stays valid.', async () => { const info = await this.collab.rotateInvites(); await this.storage.put('settings', { id: `room:${this.collab.room}`, info }); this.openShare(); }) }, { label: 'Done', primary: true, run: () => this.closeModal() }] : [{ label: 'Done', run: () => this.closeModal() }]);
    }
    openPeople() { const peers = [...this.state.peers.values()]; const messages = this.doc.all().filter(o => o.type === 'chat').sort((a, b) => a.created - b.created).slice(-40); this.panel('Better, together', `<p class="muted">${peers.length + 1} participant${peers.length ? 's' : ''} in this space${this.collab.room ? '' : ' · same-browser collaboration'}.</p><div class="panel-row"><div><strong>${esc(this.profile.name)} (you)</strong><small>${this.collab.room ? esc(this.collab.role) : 'Local editor'}</small></div><span class="avatar" style="background:${this.profile.color}22;color:${this.profile.color}">${esc(this.profile.name.slice(0, 2).toUpperCase())}</span></div>${peers.map(p => `<div class="panel-row"><div><strong>${esc(p.name)}</strong><small>${p.presenting ? 'Presenting a frame' : 'Exploring the board'}</small></div><button class="text-button" data-action="follow:${p.actor}">Follow</button></div>`).join('')}${this.following ? '<button class="text-button" data-action="stop-following">Stop following</button>' : ''}<label class="field-label">Your display name</label><div style="display:flex;gap:8px"><input id="profile-name" type="text" value="${esc(this.profile.name)}" maxlength="40" aria-label="Your display name"><button class="secondary-button" data-action="profile-save">Save</button></div><h3 style="font-size:13px;margin:25px 0 12px">Board conversation</h3>${messages.length ? messages.map(m => `<div class="thread"><div class="thread-header"><strong>${esc(m.author)}</strong><time>${new Date(m.created).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time></div><p>${esc(m.text)}</p></div>`).join('') : '<p class="muted">A place for the conversation around the work.</p>'}<textarea id="chat-text" placeholder="Say something to the team…" aria-label="Board chat message" maxlength="4000"></textarea>`, `<button class="primary-button" data-action="chat-send">Send message</button>`, 'people'); }
    saveProfile() { const name = $('#profile-name').value.trim().slice(0, 40); if (!name)
        return; this.profile.name = name; localStore.setItem('orivane-profile', JSON.stringify(this.profile)); this.collab.profile = this.profile; this.collab.presence({}); this.updateParticipants(); this.toast('Your display name is updated.'); }
    sendChat() { if (!this.writable)
        return this.toast('A viewer cannot send messages. Ask for an editor link.'); const text = $('#chat-text').value.trim(); if (!text)
        return; this.execute([{ id: uid('chat'), props: { type: 'chat', text, author: this.profile.name, authorId: this.actor, created: Date.now(), $deleted: false } }], 'Send chat message'); this.openPeople(); }
    openComment(point) { if (!this.writable)
        return; this.modal('Leave a little context', `<p class="modal-subtitle">Pin a question, an observation, or the start of a conversation.</p><textarea id="comment-text" placeholder="What is on your mind?" aria-label="Comment text" maxlength="4000"></textarea>`, [{ label: 'Cancel', run: () => this.closeModal() }, { label: 'Add comment', primary: true, run: () => { const text = $('#comment-text').value.trim(); if (!text)
                return; const id = uid('comment'); this.closeModal(); this.execute([{ id, props: { type: 'comment', x: point.x, y: point.y, text, author: this.profile.name, authorId: this.actor, created: Date.now(), resolved: false, parent: null, $deleted: false } }], 'Add comment'); this.editor.setTool('select'); this.openComments(id); } }]); }
    openComments(focus = null) { const all = this.doc.all().filter(o => o.type === 'comment'), roots = all.filter(o => !o.parent).sort((a, b) => b.created - a.created); this.panel('Conversations', `<p class="muted">Thoughtful questions lead to better ideas. ${roots.filter(o => !o.resolved).length} open thread${roots.length === 1 ? '' : 's'}.</p>${roots.length ? roots.map(o => `<article class="thread" id="thread-${o.id}" style="${o.resolved ? 'opacity:.6' : ''}"><div class="thread-header"><strong>${esc(o.author || 'Guest')}</strong><time>${new Date(o.created).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</time></div><p>${esc(o.text)}</p>${all.filter(r => r.parent === o.id).sort((a, b) => a.created - b.created).map(r => `<div class="reply"><div class="thread-header"><strong>${esc(r.author)}</strong></div><p>${esc(r.text)}</p></div>`).join('')}<div class="thread-actions"><button class="text-button" data-action="reply:${o.id}">Reply</button><button class="text-button" data-action="resolve:${o.id}">${o.resolved ? 'Reopen' : 'Resolve'}</button><button class="text-button" data-action="comment-location:${o.id}">Locate</button></div></article>`).join('') : `<div class="empty-state">${icon('comment', 35)}No conversations yet.<br>Choose the comment tool, then click anywhere on the board.</div>`}`, `<button class="primary-button" data-action="tool:comment">${icon('comment', 16)} Add a comment</button>`, 'comments'); $('#panel').querySelectorAll('[data-action^="comment-location:"]').forEach(el => el.onclick = () => { const o = this.doc.get(el.dataset.action.split(':')[1]); this.camera.x = this.renderer.width / 2 - o.x * this.camera.zoom; this.camera.y = this.renderer.height / 2 - o.y * this.camera.zoom; this.viewChanged(); }); if (focus)
        $(`#thread-${focus}`)?.scrollIntoView({ block: 'nearest' }); }
    replyComment(id) { if (!this.writable)
        return this.toast('An editor link is required to reply.'); this.modal('Keep the conversation going', `<textarea id="reply-text" placeholder="Add your reply…" aria-label="Reply text" maxlength="4000"></textarea>`, [{ label: 'Cancel', run: () => this.closeModal() }, { label: 'Reply', primary: true, run: () => { const text = $('#reply-text').value.trim(); if (!text)
                return; this.closeModal(); this.execute([{ id: uid('comment'), props: { type: 'comment', parent: id, text, author: this.profile.name, authorId: this.actor, created: Date.now(), $deleted: false } }], 'Reply to comment'); this.openComments(id); } }]); }
    resolveComment(id) { const o = this.doc.get(id); if (o)
        this.execute([{ id, props: { resolved: !o.resolved } }], o.resolved ? 'Reopen comment' : 'Resolve comment'); }
    timeRemaining() { const timer = this.doc.get('workshop_timer'); if (!timer)
        return 300000; return Math.max(0, timer.running ? timer.endAt - (Date.now() + (this.collab?.serverOffset || 0)) : timer.paused ?? 300000); }
    formatTime(ms) { const seconds = Math.ceil(ms / 1000); return `${Math.floor(seconds / 60).toString().padStart(2, '0')}:${(seconds % 60).toString().padStart(2, '0')}`; }
    updateWorkshops() {
        if (!this.doc)
            return;
        const timer = this.doc.get('workshop_timer'), pill = $('#timer-pill');
        pill.classList.toggle('hidden', !timer);
        if (timer) {
            const time = this.formatTime(this.timeRemaining());
            pill.innerHTML = `${icon('timer', 17)}<strong>${time}</strong>${timer.running ? '' : '<span class="muted">Paused</span>'}`;
            if ($('#timer-display'))
                $('#timer-display').textContent = time;
        }
        const session = this.doc.get('workshop_vote'), votes = this.doc.all().filter(o => o.type === 'vote' && o.session === session?.session && o.authorId === this.actor);
        $('#voting-pill').classList.toggle('hidden', !session || session.ended);
        if (session && !session.ended)
            $('#voting-pill').innerHTML = `${icon('vote', 17)}<span>${votes.length} / ${session.limit} votes${this.state.voting ? ' · click to vote' : ''}</span>`;
    }
    openTimer() { const timer = this.doc.get('workshop_timer'); this.panel('A little focus goes a long way', `<p class="muted">Give the next activity a little structure. The timer is shared with everyone in a live room.</p><div id="timer-display" class="timer-display">${this.formatTime(this.timeRemaining())}</div><label class="field-label">Minutes</label><input id="timer-minutes" type="number" min="1" max="180" value="5"><div class="timer-presets" style="margin-top:13px">${[3, 5, 10, 15].map(n => `<button class="secondary-button" data-action="timer-preset:${n}">${n} min</button>`).join('')}</div><div class="notice">Start a new countdown, pause it, or resume from the remaining time. A running timer continues when participants navigate away.</div>`, `<button class="secondary-button" data-action="timer-pause">${timer?.running ? 'Pause' : 'Resume'}</button><button class="primary-button" data-action="timer-start">Start timer</button><button class="icon-button" data-action="timer-reset" title="Remove timer">${icon('close')}</button>`, 'timer'); }
    startTimer() { const minutes = clamp(Number($('#timer-minutes')?.value || 5), 1, 180); this.execute([{ id: 'workshop_timer', props: { type: 'session', running: true, endAt: Date.now() + (this.collab?.serverOffset || 0) + minutes * 60000, paused: minutes * 60000, $deleted: false } }], 'Start timer'); this.openTimer(); }
    pauseTimer() { const t = this.doc.get('workshop_timer'); if (!t)
        return this.startTimer(); const ms = this.timeRemaining(); this.execute([{ id: 'workshop_timer', props: { running: !t.running, paused: ms, endAt: Date.now() + (this.collab?.serverOffset || 0) + ms } }], t.running ? 'Pause timer' : 'Resume timer'); this.openTimer(); }
    resetTimer() { this.execute([{ id: 'workshop_timer', props: { $deleted: true } }], 'Remove timer'); this.openTimer(); }
    openVoting() { const s = this.doc.get('workshop_vote'), votes = this.doc.all().filter(o => o.type === 'vote' && o.session === s?.session), counts = new Map(); for (const v of votes)
        counts.set(v.target, (counts.get(v.target) || 0) + 1); const results = [...counts].sort((a, b) => b[1] - a[1]); this.panel('Find a shared direction', `<p class="muted">Give everyone a voice. Vote on the ideas that deserve a closer look.</p>${s && !s.ended ? `<div class="notice"><strong>Voting is open.</strong> Each participant has ${s.limit} votes, at most one per object. Click an object to vote, and again to undo your vote.</div><div class="panel-row"><strong>Your votes</strong><span>${votes.filter(v => v.authorId === this.actor).length} / ${s.limit}</span></div>` : `<label class="field-label">Votes per participant</label><input id="vote-limit" type="number" min="1" max="20" value="5"><div class="notice">Votes are visible while the session is active. Participants use their current browser identity. This is an open workshop, not a secret ballot.</div>`}${results.length ? `<h3 style="font-size:13px;margin-top:22px">${s?.ended ? 'Final results' : 'Live results'}</h3>${results.map(([id, n]) => `<div class="vote-result"><strong>${n}</strong><button class="text-button" data-action="focus:${id}">${esc((this.doc.get(id)?.text || 'Untitled object').slice(0, 70))}</button><div class="vote-bar"><div style="width:${n / Math.max(1, results[0][1]) * 100}%"></div></div></div>`).join('')}` : ''}`, s && !s.ended ? `<button class="primary-button" data-action="vote-cast">Cast your votes</button><button class="secondary-button" data-action="vote-end">End voting</button>` : `<button class="primary-button" data-action="vote-start">Start a voting session</button>`, 'voting'); }
    startVoting() { const limit = clamp(Math.round(Number($('#vote-limit')?.value || 5)), 1, 20); this.execute([{ id: 'workshop_vote', props: { type: 'session', session: uid('ballot'), limit, ended: false, created: Date.now(), $deleted: false } }], 'Start voting'); this.state.voting = true; this.editor.setTool('select'); this.openVoting(); }
    castVote(target) { if (!this.writable)
        return this.toast('Voting requires an editor link.'); const session = this.doc.get('workshop_vote'); if (!session || session.ended) {
        this.state.voting = false;
        return;
    } const id = `v_${session.session}_${this.actor}_${target}`, previous = this.doc.get(id), mine = this.doc.all().filter(o => o.type === 'vote' && o.session === session.session && o.authorId === this.actor); if (!previous && mine.length >= session.limit)
        return this.toast(`You have used all ${session.limit} votes. Click an existing vote to take it back.`); this.execute([{ id, props: previous ? { $deleted: true } : { type: 'vote', session: session.session, target, authorId: this.actor, created: Date.now(), $deleted: false } }], previous ? 'Remove vote' : 'Cast vote'); this.updateWorkshops(); this.invalidate(); }
    endVoting() { this.execute([{ id: 'workshop_vote', props: { ended: true } }], 'End voting'); this.state.voting = false; this.openVoting(); }
    openFrames() { const frames = this.doc.objects().filter(o => o.type === 'frame').sort((a, b) => a.z - b.z); this.panel('The story, one frame at a time', `<p class="muted">Frames turn your canvas into a presentation. Click to explore, or present them in order.</p>${frames.length ? frames.map((o, i) => `<button class="frame-row" data-action="frame:${o.id}"><span class="frame-number">${String(i + 1).padStart(2, '0')}</span><span>${esc(o.text || `Frame ${i + 1}`)}</span></button>`).join('') : `<div class="empty-state">${icon('frame', 35)}No frames yet. Use F and drag to create one around your ideas.</div>`}`, `<button class="primary-button" data-action="present">${icon('present', 17)} Present frames</button>`, 'frames'); }
    startPresenting() { const frames = this.doc.objects().filter(o => o.type === 'frame').sort((a, b) => a.z - b.z); if (!frames.length)
        return this.toast('Create a frame first (F), then start a presentation.'); this.beforePresentation = { x: this.camera.x, y: this.camera.y, zoom: this.camera.zoom }; this.presentationFrames = frames.map(o => o.id); this.presentationIndex = 0; this.state.presenting = true; document.body.classList.add('presenting'); $('#presentation').classList.remove('hidden'); this.closeModal(); this.closePanel(); this.editor.select([]); this.showPresentationFrame(); }
    showPresentationFrame() { const o = this.doc.get(this.presentationFrames[this.presentationIndex]); if (!o)
        return; this.camera.fit({ x: o.x, y: o.y - 43, w: o.w, h: o.h + 43 }, this.renderer.width, this.renderer.height, this.renderer.width < 600 ? 25 : 65); $('#presentation-title').textContent = `${this.presentationIndex + 1} / ${this.presentationFrames.length}  ·  ${o.text || 'Untitled frame'}`; this.viewChanged(); }
    presentationStep(delta) { this.presentationIndex = clamp(this.presentationIndex + delta, 0, this.presentationFrames.length - 1); this.showPresentationFrame(); }
    stopPresenting() { this.state.presenting = false; document.body.classList.remove('presenting'); $('#presentation').classList.add('hidden'); if (this.beforePresentation)
        Object.assign(this.camera, this.beforePresentation); this.viewChanged(); }
    drawMinimap() { if (!this.minimapOpen || !this.doc)
        return; const canvas = $('#minimap'), ctx = canvas.getContext('2d'), objects = this.doc.objects(), b = unionBounds(objects), c = new Camera(); c.fit(b, 240, 150, 13); this.minimapTransform = c; ctx.clearRect(0, 0, 240, 150); ctx.fillStyle = this.state.dark ? '#242430' : '#f5f4f8'; ctx.fillRect(0, 0, 240, 150); ctx.save(); ctx.translate(c.x, c.y); ctx.scale(c.zoom, c.zoom); for (const o of objects) {
        if (['connector', 'text', 'pen'].includes(o.type))
            continue;
        ctx.fillStyle = o.fill && o.fill !== 'transparent' ? o.fill : '#d4c8e7';
        ctx.fillRect(o.x, o.y, o.w, o.h);
    } const view = this.camera.rect(this.renderer.width, this.renderer.height, 0); ctx.strokeStyle = '#8661de'; ctx.lineWidth = 1.5 / c.zoom; ctx.strokeRect(view.x, view.y, view.w, view.h); ctx.restore(); }
    editCard(o) { if (!this.writable || o.locked)
        return; this.modal('From an idea to a next step', `<label class="field-label">Task</label><textarea id="card-text" maxlength="4000">${esc(o.text)}</textarea><div class="form-grid"><label><span class="field-label">Tag</span><input id="card-tag" type="text" value="${esc(o.tag || 'TASK')}" maxlength="30"></label><label><span class="field-label">Owner</span><input id="card-assignee" type="text" value="${esc(o.assignee || '')}" placeholder="Unassigned" maxlength="50"></label><label><span class="field-label">Status</span><select id="card-status">${['Backlog', 'In progress', 'Review', 'Done'].map(v => `<option ${o.status === v ? 'selected' : ''}>${v}</option>`).join('')}</select></label><label><span class="field-label">Due date</span><input id="card-due" type="date" value="${esc(o.due || '')}" style="width:100%;padding:9px;border:1px solid var(--line);border-radius:8px;background:var(--surface)"></label></div>`, [{ label: 'Cancel', run: () => this.closeModal() }, { label: 'Save task', primary: true, run: () => { const props = { tag: $('#card-tag').value, assignee: $('#card-assignee').value, status: $('#card-status').value, due: $('#card-due').value }; this.closeModal(); this.execute([{ id: o.id, props }], 'Edit task'); } }]); this.modalCleanup = bindPlainEditor(this, o.id, 'text', $('#card-text')); $('#card-text').insertAdjacentHTML('afterend', '<p class="muted">Task text syncs as you type. Undo reverses your own edits.</p>'); }
    editTable(o) {
        if (!this.writable || o.locked) return;
        let rows = o.rows || 3, cols = o.cols || 3, disposers = [];
        const dispose = () => { for (const fn of disposers) fn(); disposers = []; };
        const render = () => { dispose(); $('#table-cells').innerHTML = `<table>${Array.from({ length: rows }, (_, r) => `<tr>${Array.from({ length: cols }, (_, c) => `<td><input data-row="${r}" data-col="${c}" aria-label="Row ${r + 1}, column ${c + 1}" maxlength="5000"></td>`).join('')}</tr>`).join('')}</table>`;
            $('#table-cells').querySelectorAll('input').forEach(el => disposers.push(bindPlainEditor(this, o.id, `cell:${el.dataset.row}:${el.dataset.col}`, el)));
        };
        this.modal('A little structure for your ideas', `<p class="modal-subtitle">Cell text syncs as you type. Undo reverses your own edits without replacing a collaborator’s text. Save applies row and column sizes.</p><div class="form-grid" style="margin-bottom:18px"><label><span class="field-label">Rows (1–100)</span><input id="table-rows" type="number" min="1" max="100" value="${rows}"></label><label><span class="field-label">Columns (1–30)</span><input id="table-cols" type="number" min="1" max="30" value="${cols}"></label></div><div id="table-cells" class="table-editor"></div>`, [{ label: 'Close', run: () => this.closeModal() }, { label: 'Save table', primary: true, run: () => { this.execute([{ id: o.id, props: { rows, cols } }], 'Resize table'); this.closeModal(); } }], true);
        this.modalCleanup = dispose; render();
        $('#table-rows').onchange = e => { rows = clamp(Math.round(Number(e.target.value) || 1), 1, 100); e.target.value = rows; render(); };
        $('#table-cols').onchange = e => { cols = clamp(Math.round(Number(e.target.value) || 1), 1, 30); e.target.value = cols; render(); };
    }
    async openActivity() { const versions = (await this.storage.all('versions')).filter(v => v.boardId === this.boardId).sort((a, b) => b.created - a.created).slice(0, 15); if (this.panelType && this.panelType !== 'activity' && this._activityWasRequested)
        return; this.panel('The story of this board', `<p class="muted">Save named snapshots as recovery points. Restoring a version opens a new local copy, leaving collaborators’ work untouched.</p>${versions.length ? versions.map(v => `<button class="frame-row" data-action="restore:${esc(v.id)}">${icon('history', 20)}<span><strong>${esc(v.name)}</strong><br><small>${new Date(v.created).toLocaleString()}</small></span></button>`).join('') : '<p class="muted">No saved versions yet.</p>'}<h3 style="font-size:13px;margin-top:26px">This session</h3>${this.activityLog.length ? this.activityLog.slice(0, 35).map(e => `<div class="panel-row"><div><strong>${e.local ? 'You' : 'A collaborator'} updated ${e.count} object${e.count === 1 ? '' : 's'}</strong><small>${new Date(e.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</small></div>${icon('check', 14)}</div>`).join('') : '<p class="muted">Changes made during this session will appear here.</p>'}`, `<button class="primary-button" data-action="snapshot">${icon('history', 17)} Save a version</button>`, 'activity'); }
    saveVersion() { this.inputDialog('Keep a little history', 'Version name', `${this.title} — ${new Date().toLocaleDateString()}`, async (name) => { await this.storage.put('versions', { id: uid('version'), boardId: this.boardId, name, created: Date.now(), snapshot: this.doc.snapshot() }); this.toast('A local recovery version has been saved.'); this.openActivity(); }); }
    async restoreVersion(id) { const v = await this.storage.get('versions', id); if (!v)
        return; this.confirm('Open a recovered copy?', `This opens “${v.name}” as a new local board. Your current board and any live room are not changed.`, async () => { await this.loadBoard(uid('board'), null, null, v.snapshot); this.execute([{ id: 'board_meta', props: { title: `${v.name} (recovered)` } }], 'Name recovered board'); this.fit(); }); }
    chooseFile(mode) { if (!this.writable)
        return this.toast('An editor link is required to import content.'); this.closePopup(); const input = $('#file-input'); input.accept = mode === 'image' ? 'image/png,image/jpeg,image/webp,image/gif' : '.json,.orivane,.excalidraw,.drawio,.xml,.rtb,.svg,.txt,.csv,image/png,image/jpeg,image/webp,image/gif'; input.multiple = mode === 'image'; input.click(); }
    async importFiles(files, point) { if (!this.writable)
        return; for (const file of files.slice(0, 30)) {
        try {
            if (file.size > 25000000)
                throw Error(`${file.name} exceeds the 25 MB import limit.`);
            if (file.type.startsWith('image/') && !file.name.toLowerCase().endsWith('.svg')) {
                await this.importImage(file, point);
                point = { x: point.x + 40, y: point.y + 40 };
                continue;
            }
            const text = await file.text(), name = file.name.toLowerCase();
            if (/\.(excalidraw|drawio|xml|rtb)$/.test(name) || name.endsWith('.json') && /"type"\s*:\s*"(excalidraw|miro-rest)"/.test(text.slice(0, 2000))) {
                const result = await importBoardFile(text, name); await this.connected.open('interchange'); this.connected.previewImport(result); continue;
            }
            if (name.endsWith('.json') || name.endsWith('.orivane')) {
                const data = JSON.parse(text), snapshot = data.snapshot || data, temp = new BoardDocument(this.actor);
                temp.merge(snapshot);
                await this.loadBoard(uid('board'), null, null, temp.snapshot());
                this.fit();
                this.toast('Board imported as a new local copy.');
            }
            else if (name.endsWith('.svg')) {
                const data = importSimpleSVG(text);
                if (data.objects.length) {
                    this.editor.pasteObjects(data.objects, 0, point);
                    this.fitSelection();
                }
                this.toast(data.warnings.length ? `Imported ${data.objects.length} objects. ${data.warnings.join('; ')}.` : `Imported ${data.objects.length} SVG objects.`);
            }
            else if (name.endsWith('.csv')) {
                const cells = this.parseCSV(text).slice(0, 100).map(r => r.slice(0, 30)), cols = Math.min(30, Math.max(1, ...cells.map(r => r.length))), o = makeObject('table', point.x, point.y, { w: cols * 180, h: Math.max(100, cells.length * 54), rows: Math.max(1, cells.length), cols, cells, text: '', fontSize: 16 });
                const { id, ...props } = o;
                this.execute([{ id, props }], 'Import CSV');
                this.editor.select([id]);
                this.fitSelection();
            }
            else if (name.endsWith('.txt') || file.type.startsWith('text/')) {
                this.editor.pasteText(text);
            }
            else
                throw Error('Supported imports: Orivane JSON, basic SVG, PNG/JPEG/WebP/GIF, CSV, and plain text.');
        }
        catch (e) {
            console.error(e);
            this.toast(e.message);
        }
    } }
    async importImage(file, point) { const url = URL.createObjectURL(file), image = new Image(); try {
        await new Promise((resolve, reject) => { image.onload = resolve; image.onerror = () => reject(Error('This image could not be decoded.')); image.src = url; });
        const scale = Math.min(1, 1800 / image.naturalWidth, 1800 / image.naturalHeight), canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
        canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
        canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
        let src = canvas.toDataURL('image/webp', .86);
        if (src.length > 2900000)
            src = canvas.toDataURL('image/jpeg', .7);
        if (src.length > 2900000)
            throw Error('Compressed image exceeds 3 MB. Try a smaller image.');
        const display = Math.min(1, 650 / canvas.width, 650 / canvas.height), o = makeObject('image', point.x, point.y, { w: canvas.width * display, h: canvas.height * display, src, text: '', fill: 'transparent', stroke: 'transparent' });
        const { id, ...props } = o;
        this.execute([{ id, props }], 'Import image');
        this.editor.select([id]);
        this.toast('Image added. Drag a grip to resize it.');
        return id;
    }
    finally {
        URL.revokeObjectURL(url);
    } }
    parseCSV(text) { const rows = []; let row = [], cell = '', quoted = false; for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (c === '"') {
            if (quoted && text[i + 1] === '"') {
                cell += '"';
                i++;
            }
            else
                quoted = !quoted;
        }
        else if (c === ',' && !quoted) {
            row.push(cell.slice(0, 5000));
            cell = '';
        }
        else if ((c === '\n' || c === '\r') && !quoted) {
            if (c === '\r' && text[i + 1] === '\n')
                i++;
            row.push(cell.slice(0, 5000));
            rows.push(row);
            row = [];
            cell = '';
            if (rows.length >= 100)
                break;
        }
        else
            cell += c;
    } if (cell || row.length) {
        row.push(cell.slice(0, 5000));
        rows.push(row);
    } return rows.length ? rows : [['']]; }
    exportMenu() { this.menu([{ action: 'export-json', label: 'Editable board (.json)', icon: 'download', key: '⌘S' }, { action: 'export-png', label: 'High-resolution image (.png)', icon: 'image' }, { action: 'export-svg', label: 'Vector scene (.svg)', icon: 'shapes' }, { action: 'export-csv', label: 'Content spreadsheet (.csv)', icon: 'table' }, null, { action: 'print', label: 'Print board', icon: 'frame' }]); }
    async exportFile(format) { this.editor.endText(); this.closePopup(); const filename = this.title.replace(/[^a-zA-Z0-9\p{L}\s_-]/gu, '').trim() || 'Orivane board'; if (format === 'json') {
        downloadFile(JSON.stringify(this.doc.snapshot(), null, 2), filename + '.orivane.json', 'application/json');
        return;
    } if (format === 'csv') {
        downloadFile(exportCSV(this.doc.objects()), filename + '.csv', 'text/csv;charset=utf-8');
        return;
    } const selected = this.editor.chosen(), objects = selected.length ? this.editor.related(selected) : this.doc.objects(); this.toast(`Preparing ${selected.length ? 'selection' : 'board'} export…`); const content = await exportScene(this.doc, format, objects); if (!content)
        throw Error('The image export could not be created.'); downloadFile(content, `${filename}.${format}`, format === 'svg' ? 'image/svg+xml' : 'image/png'); this.toast(`${format.toUpperCase()} export is ready.`); }
    async printBoard() { this.closePopup(); const win = window.open('', '_blank'); if (!win)
        return this.toast('Allow a pop-up window to print the board.'); win.document.title = this.title; win.document.body.textContent = 'Preparing board for printing…'; try {
        const blob = await exportScene(this.doc, 'png'), url = URL.createObjectURL(blob);
        const img = win.document.createElement('img');
        img.style.width = '100%';
        img.style.height = 'auto';
        img.alt = this.title;
        img.onload = () => { win.focus(); win.print(); setTimeout(() => URL.revokeObjectURL(url), 30000); };
        img.src = url;
        win.document.body.replaceChildren(img);
    }
    catch (e) {
        win.close();
        this.toast(e.message);
    } }
    help() { const shortcuts = [['Select', 'V'], ['Pan canvas', 'H / Space + drag'], ['Sticky note', 'N / double-click'], ['Text', 'T'], ['Rectangle / ellipse', 'R / O'], ['Connector / line', 'C / L'], ['Draw / erase', 'P / E'], ['Frame / comment', 'F / M'], ['Undo', 'Ctrl/⌘ + Z'], ['Redo', 'Ctrl/⌘ + Shift + Z'], ['Select all', 'Ctrl/⌘ + A'], ['Copy / paste', 'Ctrl/⌘ + C / V'], ['Duplicate', 'Ctrl/⌘ + D / Alt + drag'], ['Group / ungroup', 'Ctrl/⌘ + G / + Shift'], ['Delete selection', 'Delete / Backspace'], ['Nudge / larger nudge', 'Arrows / Shift + arrows'], ['Fit board / selection', 'Shift + 1 / 2'], ['Search board', 'Ctrl/⌘ + F'], ['Command palette', 'Ctrl/⌘ + K'], ['Export editable board', 'Ctrl/⌘ + S'], ['Constrain resize / rotation', 'Shift + drag'], ['New mind-map child', 'Tab'], ['Zoom', 'Wheel / pinch / + / −'], ['Finish text editing', 'Ctrl/⌘ + Enter']]; this.modal('A little help goes a long way.', `<p class="modal-subtitle">Orivane is a local-first whiteboard for thinking, planning, and building together.</p><div class="shortcut-grid">${shortcuts.map(([label, key]) => `<div class="shortcut-row"><span>${label}</span><kbd>${key}</kbd></div>`).join('')}</div><div class="notice"><strong>Start here:</strong> Double-click the canvas to add a note. Double-click a note or shape to edit its text. Double-click a task or table to edit its details. Drag on an empty area to select multiple objects. Use the hand tool or Space to pan. On a touch screen, use two fingers to pan and pinch.</div><div class="notice"><strong>Working together:</strong> Share → Create a live room. Copy the editor link for teammates, or a view-only link for observers. The included Node server handles persistence and access control. Static hosting alone does not provide remote collaboration.</div><p class="muted">Orivane 0.2.0 · Original open-source implementation · ${this.renderer.mode}<br>Open Workspace for accounts, SSO, AI, integrations, open-format interchange and environment diagnostics. See the capability matrix for supported scope and verification.</p>`, [{ label: 'Back to the possibilities', primary: true, run: () => this.closeModal() }], true); }
}
const app = new OrivaneApp();
app.init().catch(error => { console.error(error); const loading = $('#loading'); loading.innerHTML = `<div class="brand-name">orivane.</div><p style="padding:20px;max-width:500px;text-align:center">${esc(error.message)}<br><br>Run the included server with <code>npm start</code>, or open the standalone HTML file.</p>`; });
