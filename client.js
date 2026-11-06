window.__ModuleLoader__.load({
  id: 'thought-constellation',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const NS = 'thought-constellation';
    const API = '/thought-constellation/api';
    const STAGES = ['读取片段', '提取观点', '建立关系', '撰写总结'];

    const REL = {
      support: { label: '支持', color: '#4fd1c5' },
      cause: { label: '因果', color: '#b794f6' },
      oppose: { label: '对立', color: '#f6ad55' },
      progress: { label: '递进', color: '#63b3ed' },
      example: { label: '例证', color: '#68d391' },
    };

    const KIND = {
      assertion: '主张', assumption: '假设', causal: '因果', value: '价值', example: '例证', prediction: '预判',
    };

    /* ------------------------------------------------------------------ store */

    function initialState() {
      return {
        ready: false,
        index: [],
        project: null,
        activeId: null,
        analyzing: false,
        stage: 0,
        error: '',
        drawer: null,
        draft: '',
        modal: null,
        toast: '',
        zoomBridge: null,
        railOpen: readPanelPref('railOpen', true),
        summaryOpen: readPanelPref('summaryOpen', true),
      };
    }

    function readPanelPref(key, fallback) {
      try {
        const saved = JSON.parse(window.localStorage.getItem('tc.panels') || '{}');
        return typeof saved[key] === 'boolean' ? saved[key] : fallback;
      } catch {
        return fallback;
      }
    }

    function togglePanel(key) {
      const next = !store.get()[key];
      store.set({ [key]: next });
      try {
        window.localStorage.setItem('tc.panels', JSON.stringify({
          railOpen: store.get().railOpen,
          summaryOpen: store.get().summaryOpen,
        }));
      } catch {
        /* preference storage is optional */
      }
    }

    const store = (() => {
      let snapshot = initialState();
      const listeners = new Set();
      return {
        get: () => snapshot,
        set(patch) {
          snapshot = { ...snapshot, ...(typeof patch === 'function' ? patch(snapshot) : patch) };
          for (const listener of listeners) listener();
        },
        subscribe(listener) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      };
    })();

    // Debug handle: lets local smoke tests seed state without the browser.
    if (typeof window !== 'undefined') window.__tcStore = store;

    function useStore() {
      const [, force] = React.useState(0);
      React.useEffect(() => store.subscribe(() => force(n => n + 1)), []);
      return store.get();
    }

    let toastTimer = null;
    function toast(message) {
      store.set({ toast: message });
      if (toastTimer) clearTimeout(toastTimer);
      toastTimer = setTimeout(() => store.set({ toast: '' }), 2600);
    }

    function fail(error) {
      store.set({ error: String((error && error.message) || error || '出错了') });
      setTimeout(() => store.set(s => (s.error ? { error: '' } : {})), 6000);
    }

    /* -------------------------------------------------------------------- api */

    async function api(path, body) {
      const init = body === undefined
        ? { headers: { accept: 'application/json' }, credentials: 'same-origin' }
        : {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify(body),
          credentials: 'same-origin',
        };
      let response;
      try {
        response = await fetch(API + path, init);
      } catch {
        throw new Error('连不上本地服务，插件宿主可能没有启动');
      }
      let data = null;
      try {
        data = await response.json();
      } catch {
        /* empty body */
      }
      if (!response.ok) throw new Error((data && data.error) || `请求失败（${response.status}）`);
      return data;
    }

    /* ---------------------------------------------------------------- actions */

    async function loadAll() {
      try {
        const { projects } = await api('/index');
        const next = { index: projects, ready: true };
        const current = store.get();
        const target = current.activeId && projects.some(p => p.id === current.activeId)
          ? current.activeId
          : (projects[0] && projects[0].id) || null;
        next.activeId = target;
        store.set(next);
        if (target) await openProject(target);
      } catch (error) {
        store.set({ ready: true });
        fail(error);
      }
    }

    async function openProject(id) {
      store.set({ activeId: id, drawer: null });
      try {
        const { project } = await api(`/project?id=${encodeURIComponent(id)}`);
        store.set({ project });
      } catch (error) {
        fail(error);
      }
    }

    async function createProject(name) {
      try {
        const { project } = await api('/project/create', { name });
        const { projects } = await api('/index');
        store.set({ index: projects, project, activeId: project.id, modal: null, drawer: null });
        toast('项目已创建');
      } catch (error) {
        fail(error);
      }
    }

    async function renameProject(id, name) {
      try {
        await api('/project/rename', { id, name });
        const { projects } = await api('/index');
        const current = store.get().project;
        store.set({
          index: projects,
          modal: null,
          project: current && current.id === id ? { ...current, name } : current,
        });
        toast('已重命名');
      } catch (error) {
        fail(error);
      }
    }

    async function deleteProject(id) {
      try {
        const { projects } = await api('/project/delete', { id });
        const current = store.get();
        store.set({ index: projects, modal: null, drawer: null });
        if (current.activeId === id) {
          const next = projects[0] && projects[0].id;
          store.set({ activeId: next || null, project: null });
          if (next) await openProject(next);
        }
        toast('项目已删除');
      } catch (error) {
        fail(error);
      }
    }

    async function upload() {
      const state = store.get();
      const value = state.draft.trim();
      if (!value) return;
      if (!state.project) {
        fail(new Error('先新建一个思想项目'));
        return;
      }
      if (value.length < 20) {
        fail(new Error('这段内容有点短，再多写几句（至少 20 字）'));
        return;
      }
      store.set({ analyzing: false });
      try {
        const { project, entryCount } = await api('/entry/add', { projectId: projectIdOf(state), text: value });
        const { projects } = await api('/index');
        store.set({ project, index: projects, draft: '' });
        if (entryCount > 1) {
          const flat = project.entries.map(entry => entry.text.replace(/\s+/g, ''));
          const last = flat[flat.length - 1];
          const dup = flat.slice(0, -1).filter(text => text === last).length;
          if (dup) toast(`已存为第 ${entryCount} 段（和前面的内容重复）`);
          else toast(`已存为第 ${entryCount} 段`);
        } else {
          toast('已存为第 1 段');
        }
      } catch (error) {
        fail(error);
      }
    }

    function projectIdOf(state) {
      return state.project && state.project.id;
    }

    async function runAnalysis() {
      const state = store.get();
      if (!state.project) return;
      if (!state.project.entries.length) {
        fail(new Error('至少先上传一段思考'));
        return;
      }
      if (state.analyzing) return;
      store.set({ analyzing: true, stage: 0, error: '', drawer: null });
      const timer = setInterval(() => {
        store.set(s => (s.analyzing ? { stage: Math.min(s.stage + 1, STAGES.length - 1) } : {}));
      }, 1600);
      try {
        const { project } = await api('/analyze', { projectId: projectIdOf(store.get()) });
        const { projects } = await api('/index');
        store.set({ project, index: projects, analyzing: false, stage: 0 });
        toast('星图已更新');
      } catch (error) {
        store.set({ analyzing: false, stage: 0 });
        fail(error);
      } finally {
        clearInterval(timer);
      }
    }

    async function removeEntry(entryId) {
      const state = store.get();
      if (!state.project) return;
      try {
        const { project } = await api('/entry/delete', { projectId: state.project.id, entryId });
        const { projects } = await api('/index');
        store.set({ project, index: projects });
        toast('片段已删除，重新分析后会更新星图');
      } catch (error) {
        fail(error);
      }
    }

    /* ----------------------------------------------------------------- layout */

    function textLines(value, perLine, maxLines) {
      const source = String(value || '').replace(/\s+/g, ' ').trim();
      if (!source) return [''];
      const lines = [];
      for (let i = 0; i < source.length && lines.length < maxLines; i += perLine) {
        lines.push(source.slice(i, i + perLine));
      }
      if (source.length > perLine * maxLines) {
        const last = lines[maxLines - 1];
        lines[maxLines - 1] = last.slice(0, Math.max(1, perLine - 1)) + '…';
      }
      return lines;
    }

    function buildLayout(analysis) {
      const VBW = 1600;
      const VBH = 980;
      const cx = VBW / 2;
      const cy = VBH / 2;
      const themes = analysis.themes || [];
      const claims = analysis.claims || [];
      const questions = analysis.questions || [];
      const themeById = new Map(themes.map(theme => [theme.id, theme]));

      const themeNodes = new Map();
      themes.forEach((theme, index) => {
        const angle = -Math.PI / 2 + (index / Math.max(1, themes.length)) * Math.PI * 2;
        themeNodes.set(theme.id, {
          ...theme,
          kind: 'theme',
          x: cx + Math.cos(angle) * 236,
          y: cy + Math.sin(angle) * 148,
          width: 158,
          lines: textLines(theme.title, 9, 2),
        });
      });

      const grouped = new Map();
      for (const claim of claims) {
        if (!grouped.has(claim.themeId)) grouped.set(claim.themeId, []);
        grouped.get(claim.themeId).push(claim);
      }

      const claimNodes = new Map();
      const sectors = [];
      let cursor = -Math.PI / 2;
      for (const theme of themes) {
        const own = grouped.get(theme.id) || [];
        if (!own.length) continue;
        const span = (own.length / Math.max(1, claims.length)) * Math.PI * 2;
        sectors.push({ theme, claims: own, start: cursor, span });
        cursor += span;
      }
      if (!sectors.length && claims.length) {
        sectors.push({ theme: null, claims, start: -Math.PI / 2, span: Math.PI * 2 });
      }

      for (const sector of sectors) {
        const count = sector.claims.length;
        const limit = Math.min(sector.span, (Math.PI * 2) / Math.max(3, claims.length) + 0.32);
        sector.claims.forEach((claim, index) => {
          const offset = count === 1 ? sector.start + sector.span / 2 : sector.start + sector.span * (index + 0.5) / count;
          const angle = count === 1 ? offset : sector.start + sector.span * (index + 0.5) / count;
          const clamped = count === 1 ? angle : Math.max(sector.start + 0.06, Math.min(sector.start + sector.span - 0.06, angle));
          claimNodes.set(claim.id, {
            ...claim,
            kind: 'claim',
            x: cx + Math.cos(clamped) * 546,
            y: cy + Math.sin(clamped) * 300,
            width: 164,
            lines: textLines(claim.text, 10, 3),
            themeTitle: sector.theme ? sector.theme.title : '',
            span: limit,
          });
        });
      }

      const questionNodes = questions.map((question, index) => {
        const total = Math.max(1, questions.length);
        const angle = -Math.PI / 2 - 0.5 + ((index + 0.5) / total) * Math.PI * 2 * 0.86;
        return {
          ...question,
          kind: 'question',
          x: cx + Math.cos(angle) * 706,
          y: cy + Math.sin(angle) * 396,
          width: 176,
          lines: textLines(question.text, 11, 3),
        };
      });

      return {
        VBW,
        VBH,
        cx,
        cy,
        themes: [...themeNodes.values()],
        claims: [...claimNodes.values()],
        questions: questionNodes,
        themeById,
        claimById: claimNodes,
      };
    }

    function nodeHeight(lines) {
      return Math.max(48, lines.length * 16 + 26);
    }

    function curve(a, b, bend) {
      const mx = (a.x + b.x) / 2;
      const my = (a.y + b.y) / 2;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const length = Math.hypot(dx, dy) || 1;
      const nx = -dy / length;
      const ny = dx / length;
      const cx = mx + nx * bend;
      const cy = my + ny * bend;
      return `M ${a.x} ${a.y} Q ${cx} ${cy} ${b.x} ${b.y}`;
    }

    /* --------------------------------------------------------------- star map */

    function StarMap(props) {
      const { analysis, dimmed } = props;
      const layout = React.useMemo(() => buildLayout(analysis), [analysis]);
      const svgRef = React.useRef(null);
      const dragRef = React.useRef(null);
      const [view, setView] = React.useState({ zoom: 1, x: 0, y: 0 });
      const [hover, setHover] = React.useState(null);
      const state = useStore();

      React.useEffect(() => {
        setView({ zoom: 1, x: 0, y: 0 });
      }, [analysis]);

      React.useEffect(() => {
        const el = svgRef.current;
        if (!el) return undefined;
        const onWheel = event => {
          event.preventDefault();
          const matrix = el.getScreenCTM();
          if (!matrix) return;
          const point = new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix.inverse());
          setView(current => {
            const zoom = Math.min(2.2, Math.max(0.55, current.zoom * (event.deltaY > 0 ? 0.92 : 1.08)));
            const ratio = zoom / current.zoom;
            return { zoom, x: point.x - (point.x - current.x) * ratio, y: point.y - (point.y - current.y) * ratio };
          });
        };
        el.addEventListener('wheel', onWheel, { passive: false });
        return () => el.removeEventListener('wheel', onWheel);
      }, []);

      const toUser = event => {
        const el = svgRef.current;
        const matrix = el && el.getScreenCTM();
        if (!matrix) return { x: 0, y: 0 };
        const point = new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix.inverse());
        return point;
      };

      const onPointerDown = event => {
        if (event.button !== 0) return;
        if (event.target.closest && event.target.closest('.tc-node')) return;
        dragRef.current = { startX: event.clientX, startY: event.clientY, ox: view.x, oy: view.y, el: svgRef.current };
        event.currentTarget.setPointerCapture(event.pointerId);
      };
      const onPointerMove = event => {
        const drag = dragRef.current;
        if (!drag) return;
        const matrix = drag.el && drag.el.getScreenCTM();
        const scaleX = matrix ? 1 / matrix.a : 1;
        const scaleY = matrix ? 1 / matrix.d : 1;
        setView(current => ({
          ...current,
          x: drag.ox + (event.clientX - drag.startX) * scaleX,
          y: drag.oy + (event.clientY - drag.startY) * scaleY,
        }));
      };
      const onPointerUp = () => {
        dragRef.current = null;
      };

      const stars = React.useMemo(() => {
        const seed = (analysis.coreThesis || '').length + (analysis.claims || []).length * 17 + 7;
        const list = [];
        let value = seed;
        const next = () => {
          value = (value * 9301 + 49297) % 233280;
          return value / 233280;
        };
        for (let i = 0; i < 120; i += 1) {
          list.push({
            x: next() * 1600,
            y: next() * 980,
            r: 0.4 + next() * 1.5,
            o: 0.12 + next() * 0.5,
          });
        }
        return list;
      }, [analysis]);

      const highlighted = (kind, id) => {
        if (!hover) return true;
        if (hover.id === id) return true;
        if (hover.kind === 'claim' && kind === 'claim') {
          const a = layout.claimById.get(hover.id);
          const b = layout.claimById.get(id);
          if (!a || !b) return false;
          return (analysis.relations || []).some(rel =>
            (rel.from === a.id && rel.to === b.id) || (rel.from === b.id && rel.to === a.id));
        }
        if (hover.kind === 'theme' && kind === 'claim') {
          const claim = layout.claimById.get(id);
          return Boolean(claim && claim.themeId === hover.id);
        }
        if (hover.kind === 'claim' && kind === 'theme') {
          const claim = layout.claimById.get(hover.id);
          return Boolean(claim && claim.themeId === id);
        }
        if (hover.kind === 'question' && kind === 'claim') {
          const question = (layout.questions || []).find(item => item.id === hover.id);
          return Boolean(question && (question.claimIds || []).includes(id));
        }
        return false;
      };

      const isLinkOn = rel => {
        if (!hover) return true;
        if (hover.kind !== 'claim') return false;
        return rel.from === hover.id || rel.to === hover.id;
      };
      const isThemeLinkOn = claim => {
        if (!hover) return true;
        if (hover.kind === 'theme') return claim.themeId === hover.id;
        if (hover.kind === 'claim') return claim.id === hover.id;
        return false;
      };
      const isQuestionLinkOn = question => {
        if (!hover) return true;
        if (hover.kind !== 'question') return false;
        return question.id === hover.id;
      };

      const open = node => {
        store.set({ drawer: node });
      };

      const nodes = [...layout.themes, ...layout.claims, ...layout.questions];

      return h('div', { className: 'tc-map' + (dimmed ? ' is-dimmed' : '') },
        h('svg', {
          ref: svgRef,
          className: 'tc-svg',
          viewBox: `0 0 ${layout.VBW} ${layout.VBH}`,
          onPointerDown,
          onPointerMove,
          onPointerUp,
          onPointerCancel: onPointerUp,
          onDoubleClick: () => setView({ zoom: 1, x: 0, y: 0 }),
        },
          h('defs', null,
            h('radialGradient', { id: 'tc-core', cx: '50%', cy: '50%' },
              h('stop', { offset: '0%', stopColor: '#2a4a8a', stopOpacity: 0.55 }),
              h('stop', { offset: '100%', stopColor: '#0a1020', stopOpacity: 0 })),
            h('radialGradient', { id: 'tc-nebula', cx: '50%', cy: '50%' },
              h('stop', { offset: '0%', stopColor: '#3b2f7a', stopOpacity: 0.4 }),
              h('stop', { offset: '100%', stopColor: '#0a1020', stopOpacity: 0 })),
            h('filter', { id: 'tc-soft', x: '-30%', y: '-30%', width: '160%', height: '160%' },
              h('feGaussianBlur', { stdDeviation: 6 })),
          ),
          h('g', { transform: `translate(${view.x} ${view.y}) scale(${view.zoom})` },
            h('rect', { x: -2000, y: -2000, width: 6000, height: 6000, fill: 'transparent' }),
            h('ellipse', { cx: layout.cx - 260, cy: layout.cy - 160, rx: 520, ry: 300, fill: 'url(#tc-nebula)' }),
            h('ellipse', { cx: layout.cx, cy: layout.cy, rx: 380, ry: 240, fill: 'url(#tc-core)' }),
            stars.map((star, index) => h('circle', {
              key: 's' + index,
              cx: star.x, cy: star.y, r: star.r, fill: '#cfe0ff', opacity: star.o,
              className: 'tc-star',
              style: { animationDelay: (index % 12) * 0.4 + 's' },
            })),

            layout.themes.map(theme => h('path', {
              key: 'tl' + theme.id,
              d: `M ${layout.cx} ${layout.cy} L ${theme.x} ${theme.y}`,
              stroke: '#6f8bd0',
              strokeOpacity: hover ? 0.08 : 0.18,
              strokeWidth: 1,
              fill: 'none',
            })),

            layout.claims.map(claim => {
              const theme = layout.themeById.get(claim.themeId);
              if (!theme) return null;
              const on = isThemeLinkOn(claim);
              return h('path', {
                key: 'cl' + claim.id,
                d: curve({ x: theme.x, y: theme.y }, { x: claim.x, y: claim.y }, 18),
                stroke: '#7f93c9',
                strokeOpacity: on ? (hover ? 0.5 : 0.2) : 0.05,
                strokeWidth: 1,
                fill: 'none',
              });
            }),

            (analysis.relations || []).map((rel, index) => {
              const a = layout.claimById.get(rel.from);
              const b = layout.claimById.get(rel.to);
              if (!a || !b) return null;
              const meta = REL[rel.type] || REL.support;
              const on = isLinkOn(rel);
              return h('path', {
                key: 'r' + index,
                d: curve(a, b, 60 + (index % 3) * 22),
                stroke: meta.color,
                strokeOpacity: on ? (hover ? 0.85 : 0.42) : 0.08,
                strokeWidth: on && hover ? 1.8 : 1.1,
                strokeDasharray: rel.type === 'example' ? '4 5' : undefined,
                fill: 'none',
              });
            }),

            layout.questions.map(question => {
              const on = isQuestionLinkOn(question);
              return (question.claimIds || []).map((claimId, index) => {
                const claim = layout.claimById.get(claimId);
                if (!claim) return null;
                return h('path', {
                  key: 'q' + question.id + index,
                  d: curve({ x: claim.x, y: claim.y }, { x: question.x, y: question.y }, 26),
                  stroke: '#f6c177',
                  strokeOpacity: on ? (hover ? 0.55 : 0.18) : 0.04,
                  strokeWidth: 1,
                  strokeDasharray: '3 6',
                  fill: 'none',
                });
              });
            }),

            nodes.map((node, index) => {
              const height = nodeHeight(node.lines);
              const color = node.kind === 'theme' ? '#8fe3ff'
                : node.kind === 'question' ? '#f6c177' : '#b9c8ff';
              const dim = hover && !highlighted(node.kind, node.id);
              const interactive = node.kind !== 'theme' || true;
              return h('g', {
                key: node.kind + node.id,
                className: 'tc-node' + (dim ? ' is-dim' : '') + (state.drawer && state.drawer.id === node.id ? ' is-active' : ''),
                style: { animationDelay: Math.min(index * 40, 700) + 'ms' },
                onMouseEnter: () => setHover({ kind: node.kind, id: node.id }),
                onMouseLeave: () => setHover(null),
                onClick: event => {
                  event.stopPropagation();
                  if (interactive) open(node);
                },
              },
                h('rect', {
                  x: node.x - node.width / 2,
                  y: node.y - height / 2,
                  width: node.width,
                  height,
                  rx: node.kind === 'theme' ? 14 : 12,
                  fill: 'rgba(9, 15, 30, 0.82)',
                  stroke: color,
                  strokeOpacity: 0.5,
                  strokeWidth: 1.1,
                }),
                h('rect', {
                  x: node.x - node.width / 2,
                  y: node.y - height / 2,
                  width: node.width,
                  height: 3,
                  rx: 2,
                  fill: color,
                  opacity: 0.65,
                }),
                h('text', {
                  x: node.x,
                  y: node.y - height / 2 + 24,
                  textAnchor: 'middle',
                  fill: '#e8efff',
                  fontSize: node.kind === 'theme' ? 14 : 12.5,
                  fontFamily: 'inherit',
                },
                  node.lines.map((line, i) => h('tspan', {
                    key: i,
                    x: node.x,
                    dy: i === 0 ? 0 : 16,
                  }, line))),
                node.kind === 'theme' && node.summary
                  ? h('text', { x: node.x, y: node.y + height / 2 - 8, textAnchor: 'middle', fill: '#7f95bd', fontSize: 10 })
                  : null,
                node.kind === 'claim' && node.evidence && node.evidence.length
                  ? h('g', null,
                    h('circle', {
                      cx: node.x + node.width / 2 - 10,
                      cy: node.y - height / 2 + 10,
                      r: 7.5,
                      fill: 'rgba(79, 209, 197, 0.18)',
                      stroke: '#4fd1c5',
                      strokeOpacity: 0.6,
                    }),
                    h('text', {
                      x: node.x + node.width / 2 - 10,
                      y: node.y - height / 2 + 13.5,
                      textAnchor: 'middle',
                      fill: '#7fe0d6',
                      fontSize: 9,
                    }, String(node.evidence.length)))
                  : null,
                node.kind === 'claim'
                  ? h('circle', {
                    cx: node.x - node.width / 2 + 10,
                    cy: node.y - height / 2 + 10,
                    r: 2.4,
                    fill: color,
                    opacity: 0.4 + (node.confidence || 0.5) * 0.6,
                  })
                  : null,
              );
            }),

            h('g', { className: 'tc-node tc-core', onClick: () => open({ kind: 'core', id: 'core', coreThesis: analysis.coreThesis }) },
              h('circle', { cx: layout.cx, cy: layout.cy, r: 82, fill: 'rgba(20, 34, 66, 0.55)', stroke: '#7ee8fa', strokeOpacity: 0.4 }),
              h('circle', { cx: layout.cx, cy: layout.cy, r: 60, fill: 'rgba(9, 15, 30, 0.9)', stroke: '#7ee8fa', strokeOpacity: 0.22 }),
              h('text', {
                x: layout.cx, y: layout.cy - 8, textAnchor: 'middle', fill: '#eaf6ff', fontSize: 13.5,
              },
                textLines(analysis.coreThesis, 10, 3).map((line, i) => h('tspan', {
                  key: i, x: layout.cx, dy: i === 0 ? 0 : 18,
                }, line))),
              h('text', { x: layout.cx, y: layout.cy + 62, textAnchor: 'middle', fill: '#5f7aa8', fontSize: 9.5 }, '核心命题'),
            ),
          ),
        ),
        h('div', { className: 'tc-legend' },
          Object.keys(REL).map(type => h('span', { key: type, className: 'tc-legend-item' },
            h('i', { style: { background: REL[type].color } }), REL[type].label))),
        h('div', { className: 'tc-map-controls' },
          h('button', { type: 'button', className: 'tc-icon-btn', title: '放大', onClick: () => setView(v => ({ ...v, zoom: Math.min(2.2, v.zoom * 1.15) })) }, '+'),
          h('button', { type: 'button', className: 'tc-icon-btn', title: '缩小', onClick: () => setView(v => ({ ...v, zoom: Math.max(0.55, v.zoom / 1.15) })) }, '−'),
          h('button', { type: 'button', className: 'tc-icon-btn tc-icon-btn-wide', title: '复位', onClick: () => setView({ zoom: 1, x: 0, y: 0 }) }, '复位')),
        h('div', { className: 'tc-map-hint' }, '滚轮缩放 · 拖拽平移 · 双击复位 · 点节点看原文'),
        state.drawer ? h(Drawer, { node: state.drawer, analysis }) : null,
      );
    }

    /* ----------------------------------------------------------------- drawer */

    function Drawer(props) {
      const { node, analysis } = props;
      const claim = node.kind === 'claim'
        ? (analysis.claims || []).find(item => item.id === node.id)
        : null;
      const related = claim
        ? (analysis.relations || []).filter(rel => rel.from === claim.id || rel.to === claim.id)
        : [];
      const claimById = new Map((analysis.claims || []).map(item => [item.id, item]));
      const question = node.kind === 'question'
        ? (analysis.questions || []).find(item => item.id === node.id)
        : null;

      return h('div', { className: 'tc-drawer', onClick: event => event.stopPropagation() },
        h('button', {
          type: 'button', className: 'tc-drawer-close', title: '关闭',
          onClick: () => store.set({ drawer: null }),
        }, '×'),
        h('div', { className: 'tc-drawer-kind' },
          node.kind === 'core' ? '核心命题' : node.kind === 'theme' ? '主题' : node.kind === 'claim' ? '观点' : '待补问题'),
        h('div', { className: 'tc-drawer-title' },
          node.kind === 'core' ? node.coreThesis : node.kind === 'theme' ? node.title : node.kind === 'claim' ? node.text : node.text),
        node.kind === 'theme' && node.summary
          ? h('p', { className: 'tc-drawer-body' }, node.summary)
          : null,
        claim ? h('div', { className: 'tc-row' },
          h('span', { className: 'tc-chip' }, KIND[claim.kind] || '观点'),
          h('span', { className: 'tc-chip tc-chip-quiet' }, '支撑度 ' + Math.round((claim.confidence || 0) * 100) + '%')) : null,
        claim && claim.evidence && claim.evidence.length
          ? h('div', { className: 'tc-drawer-section' },
            h('div', { className: 'tc-drawer-label' }, '原文依据'),
            claim.evidence.map(piece => h('div', { key: piece.entryId + piece.quote.slice(0, 8), className: 'tc-quote' },
              h('div', { className: 'tc-quote-text' }, '「' + piece.quote + '」'),
              piece.context ? h('div', { className: 'tc-quote-context' }, '…' + piece.context + '…') : null)))
          : null,
        claim && !claim.evidence.length
          ? h('p', { className: 'tc-drawer-empty' }, '这条观点还找不到逐字原文依据，可能是模型从多处推论出来的。')
          : null,
        question ? h('div', { className: 'tc-drawer-section' },
          h('div', { className: 'tc-drawer-label' }, '为什么重要'),
          h('p', { className: 'tc-drawer-body' }, question.why || '还没有进一步说明')) : null,
        question && question.claimIds && question.claimIds.length
          ? h('div', { className: 'tc-drawer-section' },
            h('div', { className: 'tc-drawer-label' }, '相关观点'),
            question.claimIds.map(id => {
              const item = claimById.get(id);
              if (!item) return null;
              return h('button', {
                key: id, type: 'button', className: 'tc-linkbtn',
                onClick: () => store.set({ drawer: { ...item, kind: 'claim' } }),
              }, item.text);
            }))
          : null,
        related.length
          ? h('div', { className: 'tc-drawer-section' },
            h('div', { className: 'tc-drawer-label' }, '关系'),
            related.map((rel, index) => {
              const otherId = rel.from === (claim && claim.id) ? rel.to : rel.from;
              const other = claimById.get(otherId);
              const meta = REL[rel.type] || REL.support;
              return h('button', {
                key: index, type: 'button', className: 'tc-relrow',
                onClick: () => other && store.set({ drawer: { ...other, kind: 'claim' } }),
              },
                h('span', { className: 'tc-reldot', style: { background: meta.color } }),
                h('span', { className: 'tc-reltype' }, meta.label),
                h('span', { className: 'tc-reltext' }, other ? other.text : otherId),
                rel.note ? h('span', { className: 'tc-relnote' }, rel.note) : null);
            }))
          : null,
      );
    }

    /* -------------------------------------------------------------- synthesis */

    function synthesisSection(title, items, tone) {
      if (!items || !items.length) return null;
      return h('section', { className: 'tc-sum-section' },
        h('h3', { className: 'tc-sum-title tc-sum-title-' + (tone || 'plain') }, title),
        h('ul', { className: 'tc-sum-list' },
          items.map((item, index) => h('li', { key: index }, item))));
    }

    function SummaryPanel(props) {
      const { analysis, analyzing } = props;
      const collapse = h('button', {
        type: 'button', className: 'tc-collapse tc-collapse-floating', title: '收起总结栏',
        onClick: () => togglePanel('summaryOpen'),
      }, '›');
      if (!analysis) {
        return h('aside', { className: 'tc-summary tc-summary-empty' },
          collapse,
          h('div', { className: 'tc-summary-mark' }, '◍'),
          h('h2', null, '总结会出现在这里'),
          h('p', null, '先录入几段想法，点「开始分析」，AI 会把它们读成一个整体：核心命题、论证链、张力与盲点。'));
      }
      const synthesis = analysis.synthesis || {};
      return h('aside', { className: 'tc-summary' + (analyzing ? ' is-stale' : '') },
        collapse,
        h('div', { className: 'tc-summary-head' },
          h('span', { className: 'tc-summary-eyebrow' }, 'AI 总结'),
          h('span', { className: 'tc-summary-meta' }, `${(analysis.claims || []).length} 个观点 · ${(analysis.questions || []).length} 个问题`)),
        h('blockquote', { className: 'tc-thesis' }, analysis.coreThesis),
        synthesisSection('论证链', synthesis.logicChain, 'chain'),
        synthesisSection('张力与矛盾', synthesis.tensions, 'tension'),
        synthesisSection('还没有看到的盲点', synthesis.blindSpots, 'blind'),
        synthesisSection('下一步', synthesis.nextSteps, 'next'));
    }

    /* ------------------------------------------------------------------ shell */

    function relativeTime(value) {
      if (!value) return '';
      const diff = Date.now() - new Date(value).getTime();
      if (Number.isNaN(diff)) return '';
      const minute = 60000;
      if (diff < minute) return '刚刚';
      if (diff < 60 * minute) return Math.floor(diff / minute) + ' 分钟前';
      if (diff < 24 * 60 * minute) return Math.floor(diff / (60 * minute)) + ' 小时前';
      return new Date(value).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' });
    }

    function ProjectRail(props) {
      const { state } = props;
      const active = state.project;
      return h('div', { className: 'tc-rail' },
        h('div', { className: 'tc-brand' },
          h('div', { className: 'tc-brand-mark' }, h(ConstellationMark, { size: 22 })),
          h('div', { className: 'tc-brand-text' },
            h('div', { className: 'tc-brand-name' }, '思想星图'),
            h('div', { className: 'tc-brand-sub' }, '把零散的思考连成星图')),
          h('button', {
            type: 'button', className: 'tc-collapse', title: '收起项目栏',
            onClick: () => togglePanel('railOpen'),
          }, '‹')),
        h('button', {
          type: 'button', className: 'tc-new', onClick: () => store.set({ modal: { type: 'create', name: '' } }),
        }, h('span', { className: 'tc-plus' }, '+'), '新建思想项目'),
        h('div', { className: 'tc-rail-label' }, '我的项目'),
        h('div', { className: 'tc-projects' },
          state.index.length
            ? state.index.map(item => h('div', {
              key: item.id,
              className: 'tc-project' + (active && active.id === item.id ? ' is-active' : ''),
              onClick: () => openProject(item.id),
            },
              h('div', { className: 'tc-project-name' }, item.name),
              h('div', { className: 'tc-project-meta' },
                `${item.entryCount} 段 · ${relativeTime(item.updatedAt)}`),
              h('div', { className: 'tc-project-actions' },
                h('button', {
                  type: 'button', className: 'tc-mini', title: '重命名',
                  onClick: event => {
                    event.stopPropagation();
                    store.set({ modal: { type: 'rename', id: item.id, name: item.name } });
                  },
                }, '✎'),
                h('button', {
                  type: 'button', className: 'tc-mini', title: '删除',
                  onClick: event => {
                    event.stopPropagation();
                    store.set({ modal: { type: 'delete', id: item.id, name: item.name } });
                  },
                }, '×'))))
            : h('div', { className: 'tc-empty-note' }, '还没有项目')),

        active ? h('div', { className: 'tc-archive' },
          h('div', { className: 'tc-rail-label' }, `原文档案 · ${active.entries.length} 段`),
          h('div', { className: 'tc-entries' },
            active.entries.length
              ? active.entries.slice().reverse().map((entry, index) => h('div', { key: entry.id, className: 'tc-entry' },
                h('div', { className: 'tc-entry-head' },
                  h('span', { className: 'tc-entry-no' }, '第 ' + (active.entries.length - index) + ' 段'),
                  h('span', { className: 'tc-entry-time' }, relativeTime(entry.createdAt)),
                  h('button', {
                    type: 'button', className: 'tc-mini tc-entry-del', title: '删除这一段',
                    onClick: () => removeEntry(entry.id),
                  }, '×')),
                h('div', { className: 'tc-entry-text' }, entry.text)))
              : h('div', { className: 'tc-empty-note' }, '上传的内容会按顺序存在这里')))
          : null,
      );
    }

    function MainStage(props) {
      const { state } = props;
      const project = state.project;
      const analysis = project && project.analysis;

      let body;
      if (!project) {
        body = h('div', { className: 'tc-stage-empty' },
          h('div', { className: 'tc-stage-orb' }),
          h('h2', null, '从一个想法开始'),
          h('p', null, '新建一个思想项目，写下第一段想法。星图会随着每次分析生长。'));
      } else if (!project.entries.length) {
        body = h('div', { className: 'tc-stage-empty' },
          h('div', { className: 'tc-stage-orb' }),
          h('h2', null, project.name),
          h('p', null, '在下面写下第一段思考，上传之后点「开始分析」。'),
          h('p', { className: 'tc-stage-faint' }, '可以是一段观察、一个判断，或一件还没想通的事。'));
      } else if (!analysis) {
        body = h('div', { className: 'tc-stage-empty' },
          h('div', { className: 'tc-stage-orb is-ready' }),
          h('h2', null, `已录入 ${project.entries.length} 段思考`),
          h('p', null, '这些片段还没有被连起来。分析会提取主题、观点和待补的问题。'),
          h('button', { type: 'button', className: 'tc-analyze tc-analyze-hero', onClick: runAnalysis }, '开始分析'));
      } else {
        body = h(StarMap, { analysis, dimmed: state.analyzing });
      }

      return h('div', { className: 'tc-stage' },
        h('div', { className: 'tc-stage-head' },
          h('div', null,
            h('h1', { className: 'tc-stage-title' }, project ? project.name : '未选择项目'),
            h('div', { className: 'tc-stage-sub' },
              project
                ? `${project.entries.length} 段原文${analysis ? ' · 上次分析 ' + relativeTime(project.analyzedAt) : ' · 未分析'}`
                : '新建或选择一个项目')),
          h('div', { className: 'tc-stage-actions' },
            analysis ? h('button', {
              type: 'button', className: 'tc-ghost', onClick: runAnalysis,
              disabled: state.analyzing,
            }, state.analyzing ? '分析中…' : '重新分析') : null)),
        h('div', { className: 'tc-stage-body' }, body),
        state.analyzing
          ? h('div', { className: 'tc-progress' },
            h('div', { className: 'tc-progress-card' },
              h('div', { className: 'tc-ring' }),
              h('div', { className: 'tc-progress-title' }, STAGES[state.stage]),
              h('div', { className: 'tc-progress-steps' },
                STAGES.map((stage, index) => h('span', {
                  key: stage,
                  className: 'tc-step' + (index < state.stage ? ' is-done' : index === state.stage ? ' is-now' : ''),
                }, stage))),
              h('div', { className: 'tc-progress-hint' }, '正在读全部片段，通常需要 20–60 秒')))
          : null,
        h(Composer, { state }),
      );
    }

    function Composer(props) {
      const { state } = props;
      const project = state.project;
      const disabled = !project || state.analyzing;
      const chars = state.draft.length;
      return h('div', { className: 'tc-composer' },
        h('textarea', {
          className: 'tc-input',
          value: state.draft,
          placeholder: project ? '继续写下你的想法…（Ctrl/⌘ + Enter 上传）' : '先新建一个思想项目',
          disabled,
          rows: 3,
          onChange: event => store.set({ draft: event.target.value }),
          onKeyDown: event => {
            if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
              event.preventDefault();
              upload();
            }
          },
        }),
        h('div', { className: 'tc-composer-bar' },
          h('span', { className: 'tc-count' }, chars ? `${chars} 字` : '支持长文本，建议一次写一段完整的想法'),
          h('div', { className: 'tc-composer-actions' },
            h('button', {
              type: 'button', className: 'tc-ghost', disabled: disabled || !state.draft.trim(),
              onClick: upload,
            }, '上传'),
            h('button', {
              type: 'button', className: 'tc-analyze',
              disabled: disabled || !project || !project.entries.length,
              onClick: runAnalysis,
            }, state.analyzing ? '分析中…' : '开始分析'))));
    }

    function Modal(props) {
      const { modal } = props;
      const [value, setValue] = React.useState(modal.name || '');
      const title = modal.type === 'create' ? '新建思想项目'
        : modal.type === 'rename' ? '重命名项目' : '删除项目';
      const close = () => store.set({ modal: null });

      React.useEffect(() => {
        const onKey = event => {
          if (event.key === 'Escape') close();
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
      }, []);

      return h('div', { className: 'tc-modal-backdrop', onClick: close },
        h('div', {
          className: 'tc-modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': title,
          onClick: event => event.stopPropagation(),
        },
          h('h2', { className: 'tc-modal-title' }, title),
          modal.type === 'delete'
            ? h('p', { className: 'tc-modal-text' }, `「${modal.name}」里的全部原文和分析都会删除，无法恢复。`)
            : h('input', {
              className: 'tc-modal-input',
              autoFocus: true,
              value,
              maxLength: 40,
              placeholder: '比如：商业认知、人生规划、AI 创业',
              onChange: event => setValue(event.target.value),
              onKeyDown: event => {
                if (event.key === 'Enter') submit();
              },
            }),
          h('div', { className: 'tc-modal-actions' },
            h('button', { type: 'button', className: 'tc-ghost', onClick: close }, '取消'),
            h('button', {
              type: 'button',
              className: modal.type === 'delete' ? 'tc-danger' : 'tc-analyze',
              onClick: submit,
            }, modal.type === 'delete' ? '删除' : '确定'))),
      );

      function submit() {
        if (modal.type === 'create') {
          const name = value.trim();
          if (!name) return;
          createProject(name);
        } else if (modal.type === 'rename') {
          const name = value.trim();
          if (!name) return;
          renameProject(modal.id, name);
        } else {
          deleteProject(modal.id);
        }
      }
    }

    function Toast(props) {
      if (!props.text) return null;
      return h('div', { className: 'tc-toast' }, props.text);
    }

    function ConstellationMark(props) {
      const size = props.size || 16;
      const dot = (cx, cy, r) => h('circle', { key: cx + '-' + cy, cx, cy, r, fill: 'currentColor' });
      return h('svg', {
        width: size, height: size, viewBox: '0 0 24 24', 'aria-hidden': true, style: { display: 'block' },
      },
        h('path', {
          d: 'M5 17.5 L9.5 8 L15.5 13.5 L19 5',
          fill: 'none', stroke: 'currentColor', strokeWidth: 1.1, strokeOpacity: 0.55,
          strokeLinecap: 'round', strokeLinejoin: 'round',
        }),
        dot(5, 17.5, 1.7), dot(9.5, 8, 2.4), dot(15.5, 13.5, 1.5), dot(19, 5, 1.9),
        h('circle', { cx: 9.5, cy: 8, r: 4.4, fill: 'currentColor', opacity: 0.12 }));
    }

    function PanelHandle(props) {
      return h('button', {
        type: 'button',
        className: `tc-handle tc-handle-${props.side}`,
        title: props.hint,
        onClick: props.onOpen,
      },
        h('span', { className: 'tc-handle-chevron' }, props.side === 'left' ? '›' : '‹'),
        h('span', { className: 'tc-handle-label' }, props.label));
    }

    function Workbench() {
      const state = useStore();

      React.useEffect(() => {
        loadAll();
      }, []);

      React.useEffect(() => {
        const onKey = event => {
          if (event.key === 'Escape' && store.get().drawer) store.set({ drawer: null });
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
      }, []);

      return h('div', { className: 'tc-root' },
        h('style', null, CSS),
        h('div', { className: 'tc-shell' },
          state.railOpen ? h(ProjectRail, { state }) : h(PanelHandle, { side: 'left', label: '项目', hint: '展开项目栏', onOpen: () => togglePanel('railOpen') }),
          h(MainStage, { state }),
          state.summaryOpen ? h(SummaryPanel, { analysis: state.project && state.project.analysis, analyzing: state.analyzing }) : h(PanelHandle, { side: 'right', label: '总结', hint: '展开总结栏', onOpen: () => togglePanel('summaryOpen') })),
        state.error ? h('div', { className: 'tc-error' }, state.error) : null,
        state.modal ? h(Modal, { modal: state.modal }) : null,
        h(Toast, { text: state.toast }));
    }

    /* -------------------------------------------------------------------- css */

    const CSS = `
.tc-root, .tc-root * { box-sizing: border-box; }
.tc-root {
  height: 100%; min-height: 0; color: #dbe6ff;
  background: radial-gradient(120% 90% at 26% 0%, #0e1a30 0%, #070c18 52%, #04060d 100%);
  font-family: inherit; font-size: 13px; letter-spacing: .01em;
  display: flex; flex-direction: column; overflow: hidden;
}
.tc-root button { font-family: inherit; cursor: pointer; }
.tc-root button:disabled { cursor: default; opacity: .45; }
.tc-shell { flex: 1; min-height: 0; display: flex; }

.tc-rail {
  width: 268px; flex: none; display: flex; flex-direction: column; min-height: 0;
  padding: 18px 14px 12px; border-right: 1px solid rgba(126, 232, 250, .08);
  background: linear-gradient(180deg, rgba(10, 17, 32, .72), rgba(6, 10, 20, .5));
}
.tc-brand { display: flex; gap: 10px; align-items: center; padding: 2px 4px 18px; }
.tc-brand-text { flex: 1; min-width: 0; }
.tc-collapse {
  flex: none; width: 24px; height: 24px; display: flex; align-items: center; justify-content: center;
  border-radius: 7px; border: 1px solid transparent; background: transparent;
  color: #5f779c; font-size: 15px; line-height: 1; transition: color .18s ease, background .18s ease, border-color .18s ease;
}
.tc-collapse:hover { color: #9fe8ff; background: rgba(126, 232, 250, .09); border-color: rgba(126, 232, 250, .28); }
.tc-collapse-floating { position: absolute; top: 14px; right: 12px; z-index: 2; }
.tc-handle {
  width: 28px; flex: none; display: flex; flex-direction: column; align-items: center; gap: 12px;
  padding: 16px 0; border: 0; color: #647c9f; background: rgba(7, 12, 23, .6);
  transition: color .18s ease, background .18s ease;
}
.tc-handle-left { border-right: 1px solid rgba(126, 232, 250, .08); }
.tc-handle-right { border-left: 1px solid rgba(126, 232, 250, .08); }
.tc-handle:hover { color: #b7ecff; background: rgba(126, 232, 250, .08); }
.tc-handle-chevron { font-size: 14px; line-height: 1; }
.tc-handle-label { writing-mode: vertical-rl; letter-spacing: .26em; font-size: 10.5px; }
.tc-brand-mark {
  width: 34px; height: 34px; border-radius: 11px; display: flex; align-items: center; justify-content: center;
  color: #8fe3ff; background: rgba(126, 232, 250, .08); border: 1px solid rgba(126, 232, 250, .22);
  box-shadow: 0 0 22px rgba(80, 180, 255, .18) inset;
}
.tc-brand-name { font-size: 14px; letter-spacing: .18em; color: #eaf3ff; }
.tc-brand-sub { font-size: 10.5px; color: #6f86ad; margin-top: 3px; letter-spacing: .04em; }
.tc-new {
  width: 100%; display: flex; align-items: center; gap: 8px; justify-content: center;
  padding: 9px 12px; border-radius: 10px; color: #cfeeff; font-size: 12.5px;
  border: 1px solid rgba(126, 232, 250, .28); background: rgba(126, 232, 250, .07);
  transition: background .18s ease, border-color .18s ease;
}
.tc-new:hover { background: rgba(126, 232, 250, .13); border-color: rgba(126, 232, 250, .45); }
.tc-plus { font-size: 15px; line-height: 1; }
.tc-rail-label {
  margin: 20px 4px 8px; font-size: 10.5px; letter-spacing: .16em; color: #62809f; text-transform: uppercase;
}
.tc-projects { display: flex; flex-direction: column; gap: 3px; overflow: auto; max-height: 40%; }
.tc-project {
  position: relative; padding: 8px 10px; border-radius: 9px; cursor: pointer;
  border: 1px solid transparent; transition: background .15s ease;
}
.tc-project:hover { background: rgba(126, 180, 250, .06); }
.tc-project.is-active { background: rgba(126, 232, 250, .08); border-color: rgba(126, 232, 250, .18); }
.tc-project-name { font-size: 12.5px; color: #d8e6ff; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; padding-right: 40px; }
.tc-project-meta { font-size: 10.5px; color: #6b82a6; margin-top: 3px; }
.tc-project-actions { position: absolute; right: 6px; top: 7px; display: flex; gap: 2px; opacity: 0; transition: opacity .15s ease; }
.tc-project:hover .tc-project-actions { opacity: 1; }
.tc-mini {
  width: 20px; height: 20px; border-radius: 6px; border: none; background: transparent;
  color: #7f95b8; font-size: 11px; line-height: 1; display: flex; align-items: center; justify-content: center;
}
.tc-mini:hover { background: rgba(160, 200, 255, .12); color: #dbe9ff; }
.tc-empty-note { font-size: 11px; color: #5d7395; padding: 6px 4px; }

.tc-archive { margin-top: 22px; display: flex; flex-direction: column; min-height: 0; flex: 1; }
.tc-entries { overflow: auto; display: flex; flex-direction: column; gap: 6px; padding-bottom: 8px; }
.tc-entry { padding: 8px 9px; border-radius: 9px; background: rgba(9, 15, 28, .55); border: 1px solid rgba(120, 160, 220, .08); }
.tc-entry-head { display: flex; align-items: center; gap: 8px; margin-bottom: 4px; }
.tc-entry-no { font-size: 10px; color: #7cc9e6; letter-spacing: .05em; }
.tc-entry-time { font-size: 10px; color: #5d7395; }
.tc-entry-del { margin-left: auto; opacity: 0; }
.tc-entry:hover .tc-entry-del { opacity: 1; }
.tc-entry-text {
  font-size: 11.5px; color: #94a9cc; line-height: 1.55; max-height: 3.6em; overflow: hidden;
  display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical;
}

.tc-stage { flex: 1; min-width: 0; display: flex; flex-direction: column; position: relative; }
.tc-stage-head {
  display: flex; align-items: flex-start; justify-content: space-between; gap: 16px;
  padding: 16px 22px 10px;
}
.tc-stage-title { margin: 0; font-size: 17px; font-weight: 500; letter-spacing: .05em; color: #eaf3ff; }
.tc-stage-sub { margin-top: 5px; font-size: 11px; color: #6d84a8; }
.tc-stage-actions { display: flex; gap: 8px; }
.tc-stage-body { flex: 1; min-height: 0; position: relative; }
.tc-stage-empty {
  position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center;
  text-align: center; padding: 20px; gap: 4px;
}
.tc-stage-empty h2 { margin: 18px 0 6px; font-size: 18px; font-weight: 500; letter-spacing: .08em; color: #e6f0ff; }
.tc-stage-empty p { margin: 0; font-size: 12px; color: #7a90b4; line-height: 1.8; max-width: 420px; }
.tc-stage-faint { color: #55688a !important; font-size: 11px !important; margin-top: 4px !important; }
.tc-stage-orb {
  width: 116px; height: 116px; border-radius: 50%; position: relative;
  background: radial-gradient(circle at 50% 50%, rgba(126, 232, 250, .18), rgba(60, 90, 160, .06) 55%, transparent 70%);
  border: 1px solid rgba(126, 232, 250, .14);
  box-shadow: 0 0 60px rgba(90, 170, 255, .12);
}
.tc-stage-orb::after {
  content: ''; position: absolute; inset: 22px; border-radius: 50%;
  border: 1px dashed rgba(150, 210, 255, .18);
}
.tc-stage-orb.is-ready::after { animation: tc-spin 22s linear infinite; }
@keyframes tc-spin { to { transform: rotate(360deg); } }
.tc-analyze-hero { margin-top: 22px !important; padding: 10px 26px !important; }

.tc-map { position: absolute; inset: 0; overflow: hidden; transition: opacity .4s ease, filter .4s ease; }
.tc-map.is-dimmed { opacity: .32; filter: saturate(.6) blur(1px); }
.tc-svg { width: 100%; height: 100%; display: block; cursor: grab; touch-action: none; }
.tc-svg:active { cursor: grabbing; }
.tc-star { animation: tc-twinkle 6s ease-in-out infinite; transform-box: fill-box; }
@keyframes tc-twinkle { 0%, 100% { opacity: .18; } 50% { opacity: .65; } }
.tc-node { cursor: pointer; animation: tc-grow .65s cubic-bezier(.2, .9, .25, 1) both; transition: opacity .25s ease; }
.tc-node rect { transition: stroke-opacity .18s ease, fill .18s ease; }
.tc-node:hover rect { stroke-opacity: .95; fill: rgba(16, 26, 46, .95); }
.tc-node.is-dim { opacity: .16; }
.tc-node.is-active rect { stroke-opacity: 1; }
.tc-core { animation: tc-grow .8s ease both; }
@keyframes tc-grow { from { opacity: 0; transform: scale(.94); } to { opacity: 1; transform: scale(1); } }
.tc-legend {
  position: absolute; left: 18px; top: 12px; display: flex; gap: 12px; align-items: center;
  padding: 5px 10px; border-radius: 20px; background: rgba(6, 11, 22, .6);
  border: 1px solid rgba(126, 180, 250, .1); backdrop-filter: blur(8px); font-size: 10.5px; color: #8ba2c6;
}
.tc-legend-item { display: flex; gap: 5px; align-items: center; }
.tc-legend-item i { width: 6px; height: 6px; border-radius: 50%; display: inline-block; }
.tc-map-controls { position: absolute; right: 16px; top: 12px; display: flex; gap: 4px; }
.tc-icon-btn {
  width: 26px; height: 26px; border-radius: 8px; border: 1px solid rgba(126, 180, 250, .16);
  background: rgba(6, 11, 22, .7); color: #a9c0e2; font-size: 13px; line-height: 1;
  display: flex; align-items: center; justify-content: center;
}
.tc-icon-btn-wide { width: auto; padding: 0 9px; font-size: 10.5px; }
.tc-icon-btn:hover { color: #e6f2ff; border-color: rgba(126, 232, 250, .4); }
.tc-map-hint {
  position: absolute; left: 50%; bottom: 8px; transform: translateX(-50%);
  font-size: 10px; color: #536992; letter-spacing: .04em; pointer-events: none; white-space: nowrap;
}

.tc-drawer {
  position: absolute; right: 14px; top: 56px; bottom: 18px; width: 320px; overflow: auto;
  padding: 18px 16px 20px; border-radius: 14px;
  background: linear-gradient(180deg, rgba(13, 21, 38, .96), rgba(8, 13, 24, .97));
  border: 1px solid rgba(126, 180, 250, .18); box-shadow: 0 24px 60px rgba(0, 0, 0, .5);
  backdrop-filter: blur(14px); animation: tc-slide .28s ease both;
}
@keyframes tc-slide { from { opacity: 0; transform: translateX(12px); } to { opacity: 1; transform: none; } }
.tc-drawer-close {
  position: absolute; right: 10px; top: 8px; width: 24px; height: 24px; border: none; border-radius: 7px;
  background: transparent; color: #7f95b8; font-size: 16px;
}
.tc-drawer-close:hover { background: rgba(160, 200, 255, .1); color: #eaf3ff; }
.tc-drawer-kind { font-size: 10px; letter-spacing: .16em; color: #67d0e8; }
.tc-drawer-title { margin-top: 8px; font-size: 15px; line-height: 1.6; color: #eaf3ff; letter-spacing: .02em; }
.tc-drawer-body { margin: 10px 0 0; font-size: 12px; color: #93a9cc; line-height: 1.75; }
.tc-drawer-empty { font-size: 11.5px; color: #6d84a8; line-height: 1.7; }
.tc-row { display: flex; gap: 6px; margin-top: 12px; flex-wrap: wrap; }
.tc-chip {
  font-size: 10px; padding: 3px 8px; border-radius: 20px; color: #9fe6f6;
  background: rgba(79, 209, 197, .1); border: 1px solid rgba(79, 209, 197, .22);
}
.tc-chip-quiet { color: #91a8cc; background: rgba(130, 170, 230, .08); border-color: rgba(130, 170, 230, .16); }
.tc-drawer-section { margin-top: 18px; }
.tc-drawer-label { font-size: 10px; letter-spacing: .14em; color: #6f86ad; margin-bottom: 8px; }
.tc-quote { margin-bottom: 8px; padding: 9px 10px; border-radius: 9px; background: rgba(126, 232, 250, .05); border-left: 2px solid rgba(126, 232, 250, .35); }
.tc-quote-text { font-size: 12px; line-height: 1.7; color: #c9dcf7; }
.tc-quote-context { margin-top: 6px; font-size: 10.5px; color: #6d84a8; line-height: 1.6; }
.tc-linkbtn {
  display: block; width: 100%; text-align: left; margin-bottom: 5px; padding: 7px 9px; border-radius: 8px;
  font-size: 11.5px; color: #b9cff0; line-height: 1.6; background: rgba(9, 15, 28, .6);
  border: 1px solid rgba(126, 180, 250, .1);
}
.tc-linkbtn:hover { border-color: rgba(126, 232, 250, .35); color: #e6f2ff; }
.tc-relrow {
  display: flex; align-items: baseline; gap: 6px; width: 100%; text-align: left;
  padding: 6px 8px; border-radius: 8px; background: transparent; border: 1px solid transparent; color: #a9c0e2;
}
.tc-relrow:hover { background: rgba(126, 180, 250, .07); border-color: rgba(126, 180, 250, .14); }
.tc-reldot { width: 5px; height: 5px; border-radius: 50%; flex: none; }
.tc-reltype { font-size: 10px; color: #7f95b8; flex: none; }
.tc-reltext { font-size: 11.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tc-relnote { font-size: 10px; color: #5f7495; flex: none; }

.tc-summary {
  width: 332px; flex: none; overflow: auto; padding: 22px 20px 28px; position: relative;
  border-left: 1px solid rgba(126, 232, 250, .07);
  background: linear-gradient(180deg, rgba(9, 15, 28, .55), rgba(5, 9, 18, .7));
  transition: opacity .4s ease;
}
.tc-summary.is-stale { opacity: .4; }
.tc-summary-empty { display: flex; flex-direction: column; justify-content: center; align-items: flex-start; gap: 6px; }
.tc-summary-mark { font-size: 22px; color: rgba(126, 232, 250, .5); }
.tc-summary-empty h2 { margin: 6px 0 0; font-size: 14px; font-weight: 500; color: #d6e5ff; letter-spacing: .05em; }
.tc-summary-empty p { margin: 0; font-size: 11.5px; color: #6f86ad; line-height: 1.8; }
.tc-summary-head { display: flex; align-items: baseline; justify-content: space-between; margin-bottom: 14px; padding-right: 30px; }
.tc-summary-eyebrow { font-size: 10px; letter-spacing: .18em; color: #67d0e8; }
.tc-summary-meta { font-size: 10px; color: #5d7395; }
.tc-thesis {
  margin: 0 0 22px; padding: 0 0 0 14px; border-left: 2px solid rgba(126, 232, 250, .5);
  font-size: 15px; line-height: 1.8; color: #eef6ff; letter-spacing: .03em;
}
.tc-sum-section { margin-bottom: 20px; }
.tc-sum-title { margin: 0 0 8px; font-size: 11px; font-weight: 500; letter-spacing: .12em; color: #8299bd; }
.tc-sum-title-chain { color: #7fc6ff; }
.tc-sum-title-tension { color: #f0b072; }
.tc-sum-title-blind { color: #c39bf0; }
.tc-sum-title-next { color: #7fe0c0; }
.tc-sum-list { margin: 0; padding: 0 0 0 14px; }
.tc-sum-list li { font-size: 11.8px; line-height: 1.85; color: #a8bcdc; margin-bottom: 4px; }
.tc-sum-list li::marker { color: rgba(126, 180, 250, .4); }

.tc-composer { padding: 10px 22px 16px; border-top: 1px solid rgba(126, 180, 250, .07); }
.tc-input {
  width: 100%; resize: none; min-height: 62px; max-height: 150px; padding: 11px 13px;
  border-radius: 11px; background: rgba(8, 13, 24, .72); color: #dbe6ff; font-family: inherit;
  font-size: 12.5px; line-height: 1.75; border: 1px solid rgba(126, 180, 250, .14); outline: none;
  transition: border-color .18s ease, box-shadow .18s ease;
}
.tc-input:focus { border-color: rgba(126, 232, 250, .38); box-shadow: 0 0 0 3px rgba(126, 232, 250, .06); }
.tc-input::placeholder { color: #4f6486; }
.tc-composer-bar { display: flex; align-items: center; justify-content: space-between; margin-top: 8px; gap: 12px; }
.tc-count { font-size: 10.5px; color: #5d7395; }
.tc-composer-actions { display: flex; gap: 8px; }
.tc-analyze {
  padding: 7px 18px; border-radius: 9px; font-size: 12px; letter-spacing: .06em; color: #04121c;
  background: linear-gradient(135deg, #8fe9fa, #6fd0ee); border: none;
  box-shadow: 0 6px 20px rgba(100, 210, 245, .18); transition: filter .18s ease;
}
.tc-analyze:hover:not(:disabled) { filter: brightness(1.08); }
.tc-ghost {
  padding: 7px 14px; border-radius: 9px; font-size: 12px; color: #b6cbea;
  background: transparent; border: 1px solid rgba(126, 180, 250, .2);
}
.tc-ghost:hover:not(:disabled) { border-color: rgba(126, 232, 250, .45); color: #e6f2ff; }
.tc-danger { padding: 7px 18px; border-radius: 9px; font-size: 12px; color: #ffe6e6; background: rgba(220, 80, 80, .22); border: 1px solid rgba(240, 120, 120, .4); }

.tc-progress {
  position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
  background: rgba(4, 8, 16, .55); backdrop-filter: blur(2px); z-index: 5;
}
.tc-progress-card {
  width: 320px; padding: 22px 22px 18px; border-radius: 16px; text-align: center;
  background: rgba(10, 17, 32, .92); border: 1px solid rgba(126, 232, 250, .18);
  box-shadow: 0 30px 80px rgba(0, 0, 0, .5);
}
.tc-ring {
  width: 44px; height: 44px; margin: 2px auto 14px; border-radius: 50%;
  border: 1.5px solid rgba(126, 232, 250, .15); border-top-color: #8fe9fa;
  animation: tc-spin .9s linear infinite;
}
.tc-progress-title { font-size: 14px; color: #eaf3ff; letter-spacing: .12em; }
.tc-progress-steps { display: flex; justify-content: center; gap: 10px; margin: 14px 0 10px; }
.tc-step { font-size: 10px; color: #4f6486; }
.tc-step.is-done { color: #6f8fb8; }
.tc-step.is-now { color: #8fe9fa; }
.tc-progress-hint { font-size: 10.5px; color: #5d7395; }

.tc-error {
  position: absolute; left: 50%; bottom: 26px; transform: translateX(-50%); z-index: 20;
  max-width: 560px; padding: 9px 16px; border-radius: 10px; font-size: 12px;
  background: rgba(70, 18, 24, .9); color: #ffc9c9; border: 1px solid rgba(240, 120, 120, .3);
  box-shadow: 0 14px 40px rgba(0, 0, 0, .45);
}
.tc-toast {
  position: absolute; left: 50%; bottom: 76px; transform: translateX(-50%); z-index: 21;
  padding: 8px 16px; border-radius: 20px; font-size: 11.5px; color: #cfeaff;
  background: rgba(12, 22, 40, .92); border: 1px solid rgba(126, 232, 250, .22);
  animation: tc-toast-in .25s ease both;
}
@keyframes tc-toast-in { from { opacity: 0; transform: translate(-50%, 6px); } to { opacity: 1; transform: translate(-50%, 0); } }

.tc-modal-backdrop {
  position: absolute; inset: 0; z-index: 30; display: flex; align-items: center; justify-content: center;
  background: rgba(3, 6, 12, .6); backdrop-filter: blur(3px);
}
.tc-modal {
  width: 380px; padding: 22px; border-radius: 16px;
  background: linear-gradient(180deg, rgba(14, 22, 40, .98), rgba(8, 13, 24, .99));
  border: 1px solid rgba(126, 232, 250, .18); box-shadow: 0 30px 80px rgba(0, 0, 0, .55);
  animation: tc-grow .3s ease both;
}
.tc-modal-title { margin: 0 0 14px; font-size: 14px; font-weight: 500; letter-spacing: .08em; color: #eaf3ff; }
.tc-modal-text { margin: 0 0 16px; font-size: 12px; color: #93a9cc; line-height: 1.8; }
.tc-modal-input {
  width: 100%; padding: 10px 12px; border-radius: 10px; font-size: 12.5px; font-family: inherit;
  background: rgba(6, 11, 22, .8); color: #dbe6ff; border: 1px solid rgba(126, 180, 250, .2); outline: none;
}
.tc-modal-input:focus { border-color: rgba(126, 232, 250, .45); }
.tc-modal-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 18px; }

@media (max-width: 1180px) {
  .tc-summary { width: 280px; }
  .tc-rail { width: 232px; }
}
@media (prefers-reduced-motion: reduce) {
  .tc-node, .tc-core, .tc-modal, .tc-drawer { animation: none !important; }
  .tc-star, .tc-stage-orb.is-ready::after, .tc-ring { animation: none !important; }
}
`;

    /* ------------------------------------------------------------------- boot */

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist',
          id: 'thought-constellation',
          order: 20,
          label: () => '思想星图',
        }, ConstellationMark));
        ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main',
          key: 'thought-constellation',
        }, Workbench));
      },
    };
  },
});
