import { makeObject } from './model.js';
export const templateCatalog = [{ id: 'discovery', name: 'Product discovery', category: 'Featured', desc: 'From the first signal to a shared direction.', color: '#fff1b5' }, { id: 'brainstorm', name: 'The big brainstorm', category: 'Ideation', desc: 'A little structure. A lot of possibility.', color: '#e6ddff' }, { id: 'kanban', name: 'Team kanban', category: 'Planning', desc: 'Make the work visible, keep it moving.', color: '#dbf2e9' }, { id: 'retro', name: 'Look back, move forward', category: 'Workshops', desc: 'A thoughtful space for your next retrospective.', color: '#ffe0e6' }, { id: 'mindmap', name: 'Connected thinking', category: 'Ideation', desc: 'Follow an idea and see where it leads.', color: '#d9eaff' }, { id: 'flowchart', name: 'Map the process', category: 'Diagramming', desc: 'Make every next step a little clearer.', color: '#e5e0fb' }, { id: 'swot', name: 'A different perspective', category: 'Strategy', desc: 'Explore strengths, opportunities, and more.', color: '#ffedcc' }, { id: 'journey', name: 'Customer journey', category: 'Research', desc: 'See the experience through their eyes.', color: '#d7f0f0' }, { id: 'wireframe', name: 'From idea to interface', category: 'Design', desc: 'Sketch the screen before the pixels.', color: '#e8eaf1' }, { id: 'roadmap', name: 'The road ahead', category: 'Planning', desc: 'Align your team around what is coming.', color: '#f1e3fa' }];
export function createTemplate(name = 'discovery', offset = { x: 0, y: 0 }) {
    const objects = [];
    let z = 1;
    const add = (type, x, y, w, h, text, props = {}) => { const o = makeObject(type, x + offset.x, y + offset.y, { w, h, text, z: z++, ...props }); objects.push(o); return o; };
    const text = (x, y, w, h, t, fs = 18, props = {}) => add('text', x, y, w, h, t, { fontSize: fs, ...props });
    const frame = (x, y, w, h, t, fill = '#ffffff') => add('frame', x, y, w, h, t, { fill, stroke: '#dfe2eb', fontSize: 19, bold: true, radius: 12 });
    const note = (x, y, t, fill = '#fff0a6', w = 146, h = 135) => add('sticky', x, y, w, h, t, { fill, fontSize: 17, stroke: 'transparent' });
    const link = (a, b, props = {}) => add('connector', a.x - offset.x + a.w, a.y - offset.y + a.h / 2, Math.max(0, b.x - a.x - a.w), Math.max(0, b.y - a.y), '', { from: { id: a.id, side: 'right' }, to: { id: b.id, side: 'left' }, stroke: '#8c85ac', strokeWidth: 2, arrowEnd: true, route: 'elbow', ...props });
    if (name === 'discovery') {
        text(0, 0, 700, 28, 'ATLAS  /  PRODUCT STUDIO', 14, { bold: true });
        text(0, 45, 1420, 80, 'Make room for the next big thing.', 48, { bold: true });
        text(0, 129, 1300, 45, 'Product discovery • A shared space to ask better questions, connect ideas, and move forward.', 21);
        add('rect', 1535, 46, 247, 56, 'DISCOVERY IN PROGRESS', { fill: '#e8e3fa', stroke: 'transparent', fontSize: 13, bold: true, align: 'center', radius: 28 });
        frame(0, 270, 554, 426, '01   Discover the opportunity');
        text(28, 294, 470, 26, 'WHAT ARE WE HEARING?', 13, { bold: true });
        note(28, 347, '“I want fewer tools,\nnot another tab.”');
        note(204, 347, 'Make the first\nfive minutes\nfeel effortless.', '#ffdce3');
        note(380, 347, 'A clear next step\nis better than\nten options.', '#dce9ff');
        note(28, 515, 'People want to\nsee the big picture.', '#ddf1e5');
        note(204, 515, 'Keep the team\nin the loop,\nnot in a meeting.');
        note(380, 515, 'What would\nmake this feel\nsurprisingly easy?', '#e8ddff');
        frame(624, 270, 622, 426, '02   Connect the dots');
        text(652, 294, 530, 26, 'FROM A SIGNAL TO A SOLUTION', 13, { bold: true });
        const a = add('rect', 656, 363, 154, 76, 'Customer\nsignal', { fill: '#eee8ff', stroke: '#cfc1f1', align: 'center', fontSize: 17, radius: 12 });
        const b = add('diamond', 865, 341, 130, 120, 'Core\nneed', { fill: '#fff0b9', stroke: '#dcc777', align: 'center', fontSize: 17 });
        const d = add('rect', 1050, 363, 154, 76, 'A better\nexperience', { fill: '#ddf0e6', stroke: '#afd6c0', align: 'center', fontSize: 17, radius: 12 });
        link(a, b);
        link(b, d);
        add('rect', 658, 521, 552, 129, 'How might we make working together\nfeel as natural as thinking out loud?', { fill: '#f5f2fc', stroke: 'transparent', fontSize: 23, align: 'center', radius: 12 });
        frame(1316, 270, 466, 426, '03   Decide what’s next');
        text(1342, 294, 189, 28, 'EXPLORE NOW', 13, { bold: true });
        text(1560, 294, 195, 28, 'UP NEXT', 13, { bold: true });
        add('card', 1342, 347, 194, 138, 'Talk to five\nnew customers', { fontSize: 17, tag: 'RESEARCH', assignee: 'Team', stroke: '#e1e2ed' });
        add('card', 1560, 347, 194, 138, 'Sketch the\nfirst-run flow', { fontSize: 17, tag: 'DESIGN', assignee: 'Team', stroke: '#e1e2ed' });
        add('card', 1342, 510, 194, 138, 'Map the moments\nthat matter', { fontSize: 17, tag: 'DISCOVERY', assignee: 'Team', stroke: '#e1e2ed' });
        add('card', 1560, 510, 194, 138, 'Test a lighter\nway to collaborate', { fontSize: 17, tag: 'EXPERIMENT', assignee: 'Team', stroke: '#e1e2ed' });
        frame(0, 813, 554, 445, '04   Find the focus');
        text(25, 840, 460, 28, 'BIG IMPACT, SMALL FIRST STEP', 13, { bold: true });
        add('rect', 30, 905, 490, 303, '', { fill: '#f7f5fc', stroke: 'transparent' });
        add('connector', 275, 905, 0, 303, '', { stroke: '#c8c3d8', arrowEnd: false });
        add('connector', 30, 1056, 490, 0, '', { stroke: '#c8c3d8', arrowEnd: false });
        note(340, 937, 'Start here', '#ddf1e5', 137, 95);
        note(74, 1082, 'Keep exploring', '#e8ddff', 148, 95);
        frame(624, 813, 622, 445, '05   Share a little inspiration');
        text(655, 859, 530, 58, 'Good ideas get better together.', 29, { bold: true });
        text(655, 940, 530, 140, 'Select a note and make it yours.\nConnect the ideas that belong together.\nInvite someone to build on your thinking.', 22);
        add('rect', 658, 1130, 552, 72, 'Small steps. Shared direction.', { fill: '#fff0b9', stroke: 'transparent', fontSize: 22, align: 'center', radius: 10 });
        frame(1316, 813, 466, 445, '06   Leave with a next step');
        note(1350, 876, 'What did we learn?', '#dce9ff', 182, 155);
        note(1566, 876, 'What will we try?', '#ffdce3', 182, 155);
        text(1350, 1080, 387, 95, 'Use the timer, start a vote,\nor present your frames to the team.', 21);
    }
    else if (name === 'brainstorm') {
        frame(0, 60, 1050, 700, 'The big brainstorm');
        text(35, 90, 960, 80, 'What could we do differently?', 36, { bold: true });
        text(35, 175, 940, 45, 'One idea per note. Build on each other. Leave room for the unexpected.', 19);
        const ideas = ['Start with the user', 'Make it delightfully simple', 'Challenge an assumption', 'What would we try in a week?', 'Borrow from another industry', 'Think ten times bigger', 'Remove a step', 'Make room for a wild idea'];
        ideas.forEach((t, i) => note(35 + (i % 4) * 253, 270 + Math.floor(i / 4) * 207, t, ['#fff0a6', '#ffdce3', '#dce9ff', '#ddf1e5'][i % 4], 216, 177));
    }
    else if (name === 'kanban') {
        frame(0, 60, 1130, 770, 'Team kanban');
        ['Backlog', 'In progress', 'Review', 'Done'].forEach((t, i) => { add('rect', 25 + i * 276, 95, 252, 695, '', { fill: ['#f1eff9', '#eef3fc', '#fff8e4', '#eff8f0'][i], stroke: 'transparent', radius: 10 }); text(44 + i * 276, 123, 210, 40, t, 23, { bold: true }); ['Align on the goal', 'Make the work visible', 'Share an early version'].slice(0, i === 3 ? 1 : 3).forEach((v, k) => add('card', 40 + i * 276, 192 + k * 174, 222, 145, v, { tag: ['PLANNING', 'DESIGN', 'REVIEW', 'SHIPPED'][i], assignee: 'Team', fontSize: 18, stroke: '#dce0ec' })); });
    }
    else if (name === 'retro') {
        frame(0, 60, 1040, 680, 'Look back, move forward');
        ['What went well?', 'What was tricky?', 'What will we try?'].forEach((t, i) => { text(30 + i * 342, 90, 300, 65, t, 25, { bold: true }); for (let j = 0; j < 2; j++)
            note(42 + i * 342, 185 + j * 242, j ? 'One small next step…' : 'Add your reflection…', ['#ddf1e5', '#ffdce3', '#dce9ff'][i], 270, 198); });
    }
    else if (name === 'mindmap') {
        frame(0, 50, 1110, 720, 'Connected thinking');
        const a = add('rect', 425, 325, 225, 110, 'The big idea', { fill: '#e5dcff', stroke: '#baaae9', align: 'center', fontSize: 24, bold: true, tag: 'mindmap' });
        ['People', 'Possibilities', 'Questions', 'Next steps'].forEach((t, i) => { const b = add('rect', i < 2 ? 65 : 820, 190 + (i % 2) * 300, 220, 88, t, { fill: ['#fff0a6', '#ffdce3', '#dce9ff', '#ddf1e5'][i], stroke: 'transparent', align: 'center', fontSize: 21, tag: 'mindmap' }); link(a, b, { from: { id: a.id, side: 'auto' }, to: { id: b.id, side: 'auto' }, route: 'curve' }); });
    }
    else if (name === 'flowchart') {
        frame(0, 60, 1150, 520, 'Map the process');
        const a = add('ellipse', 35, 245, 170, 85, 'Start', { fill: '#ddf1e5', align: 'center' }), b = add('rect', 280, 245, 185, 85, 'Understand\nthe problem', { fill: '#e7e0fb', align: 'center' }), c = add('diamond', 550, 208, 170, 155, 'Ready to\nmove on?', { fill: '#fff0a6', align: 'center' }), d = add('rect', 810, 245, 245, 85, 'Try the next step', { fill: '#dce9ff', align: 'center' });
        link(a, b);
        link(b, c);
        link(c, d, { text: 'Yes' });
        const e = add('rect', 536, 435, 198, 82, 'Learn and iterate', { fill: '#ffdce3', align: 'center' });
        link(c, e, { route: 'straight', from: { id: c.id, side: 'bottom' }, to: { id: e.id, side: 'top' }, text: 'Not yet' });
    }
    else if (name === 'swot') {
        frame(0, 60, 1050, 890, 'A different perspective');
        ['Strengths', 'Weaknesses', 'Opportunities', 'Threats'].forEach((t, i) => { const x = 26 + (i % 2) * 510, y = 97 + Math.floor(i / 2) * 416; add('rect', x, y, 486, 390, '', { fill: ['#eff8f0', '#fff2f4', '#eff4fe', '#fffae9'][i], stroke: 'transparent' }); text(x + 22, y + 22, 440, 58, t, 29, { bold: true }); note(x + 24, y + 120, 'Add an insight', ['#ddf1e5', '#ffdce3', '#dce9ff', '#fff0a6'][i], 196, 193); note(x + 259, y + 120, 'Consider another angle', ['#ddf1e5', '#ffdce3', '#dce9ff', '#fff0a6'][i], 196, 193); });
    }
    else if (name === 'journey') {
        frame(0, 60, 1410, 635, 'Customer journey');
        add('table', 25, 95, 1360, 565, '', { rows: 5, cols: 6, fontSize: 17, cells: [['', 'Discover', 'Explore', 'Get started', 'Find value', 'Come back'], ['Goal', 'Recognize a need', 'Understand options', 'Take the first step', 'Make progress', 'Build a habit'], ['Touchpoint', 'A recommendation', 'Product page', 'Welcome flow', 'Core experience', 'A helpful reminder'], ['Feeling', 'Curious', 'Hopeful', 'A little unsure', 'Delighted', 'Confident'], ['Opportunity', 'Be clear', 'Show, don’t tell', 'Remove friction', 'Celebrate progress', 'Stay useful']] });
    }
    else if (name === 'wireframe') {
        frame(0, 60, 1130, 790, 'From idea to interface');
        [30, 580].forEach((x, i) => { add('rect', x, 100, 520, 703, '', { fill: '#ffffff', stroke: '#cbd0df', radius: 8 }); add('rect', x, 100, 520, 54, i ? 'Your workspace' : 'A new beginning', { fill: '#edeaf6', stroke: 'transparent', fontSize: 18, align: 'center' }); if (i) {
            add('rect', x + 20, 178, 110, 598, '', { fill: '#f4f3f8', stroke: 'transparent' });
            ['Overview', 'Projects', 'Activity', 'Settings'].forEach((t, k) => text(x + 32, 205 + k * 52, 100, 30, t, 14));
            for (let k = 0; k < 4; k++)
                add('rect', x + 153 + (k % 2) * 172, 242 + Math.floor(k / 2) * 215, 153, 181, 'Your content', { fill: '#f1f3f8', stroke: '#d5d9e4', align: 'center', fontSize: 15 });
        }
        else {
            text(x + 35, 220, 450, 100, 'A little less friction.\nA lot more possibility.', 29, { bold: true });
            add('rect', x + 35, 384, 450, 193, 'Image or illustration', { fill: '#eeeaf8', stroke: 'transparent', align: 'center', fontSize: 19 });
            add('rect', x + 35, 625, 450, 57, 'Get started', { fill: '#d5c8f6', stroke: 'transparent', align: 'center', fontSize: 19 });
        } });
    }
    else if (name === 'roadmap') {
        frame(0, 60, 1310, 685, 'The road ahead');
        ['Now', 'Next', 'Later'].forEach((t, i) => { text(30 + i * 428, 95, 380, 55, t, 30, { bold: true }); add('rect', 25 + i * 428, 175, 404, 515, '', { fill: ['#f0ecfb', '#eef5ff', '#f0f8f2'][i], stroke: 'transparent', radius: 10 }); ['Understand the need', 'Make a first version', 'Learn from the team'].forEach((t, k) => add('card', 45 + i * 428, 201 + k * 160, 364, 135, t, { tag: ['DISCOVERY', 'BUILD', 'LEARN'][i], assignee: 'Team', stroke: '#dfe1eb', fontSize: 21 })); });
    }
    return objects;
}
