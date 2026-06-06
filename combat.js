/* ===== combat.js — Combat Round module (v2) =====
 * Global dependencies from index.html:
 *   FB (db, roomId, playerName, isKP), KP (_playerCards, _onlineIds, getNpcs),
 *   App (curTab), esc(), uid()
 * Called by index.html: renderCombatTab(), _cbOnRollResult(e), _cbOnDamageResult(e),
 *   _cbBindStartModal() [called on DOMContentLoaded]
 * ================================================= */

/* ── Constants ── */
const CB_ALLY_X  = [34, 22, 10];   // X% per ally slot (front→back)
const CB_ENEMY_X = [60, 72, 84];   // X% per enemy slot (front→back)
const CB_CONDITIONS = [
  {key:'injured',      label:'轻伤'},
  {key:'severelyInjured', label:'重伤'},
  {key:'unconscious',  label:'昏迷'},
  {key:'prone',        label:'倒地'},
  {key:'dead',         label:'死亡'},
  {key:'insane',       label:'疯狂'},
];
const CB_TERRAIN_LABELS = {indoor:'🏠 室内', street:'🏙 街道', wild:'🌲 野外', grass:'🌿 草地', dungeon:'🕯 地下城'};
const CB_GRADE_COLORS = {
  '大成功':'#f0c060', '极难成功':'#c084fc', '困难成功':'#60a5fa',
  '成功':'#2ecc71', '失败':'rgba(180,178,200,.85)', '大失败':'#e74c3c'
};
const CB_GRADE_SIZES = {'大成功':'64px','极难成功':'56px','困难成功':'56px','成功':'48px','失败':'48px','大失败':'64px'};

/* ── CB object ── */
const CB = {
  _listener:        null,   // Firebase combat node listener
  _rollsRef:        null,   // Firebase rolls listener for result banner
  _rollsFn:         null,
  _state:           null,   // cached Firebase combat snapshot
  _prevTurnIdx:     -1,     // detect turn change for "your turn" notif
  _yourTurnTimer:   null,
  _animBusy:        false,  // true while a token animation is playing
  _animBusyTimer:   null,   // clears _animBusy after anim window
  _animRenderTimer: null,   // deferred renderCombatTab when anim is busy

  startListening() {
    if (!FB.db || !FB.roomId || this._listener) return;
    try {
      const ref = FB.db.ref(`rooms/${FB.roomId}/combat`);
      this._listener = ref.on('value', snap => {
        const newState = snap.val();
        const prevIdx  = this._state?.currentActorIndex ?? -1;
        this._state    = newState;
        if (App.curTab === 'combat') {
          // If an animation is playing, defer the re-render so the DOM isn't destroyed mid-animation
          clearTimeout(this._animRenderTimer);
          if (this._animBusy) {
            this._animRenderTimer = setTimeout(() => renderCombatTab(), 620);
          } else {
            renderCombatTab();
          }
          // Show "your turn" if it just became our turn
          const cur = newState?.turnOrder?.[newState.currentActorIndex ?? 0];
          if (cur && cur.id === FB.playerName && newState?.active &&
              (newState.currentActorIndex ?? 0) !== prevIdx) {
            _cbShowYourTurn();
          }
        }
      });
      this._listenRolls();
    } catch(e) { console.error('CB.startListening:', e); }
  },

  stopListening() {
    try {
      if (this._listener && FB.db && FB.roomId)
        FB.db.ref(`rooms/${FB.roomId}/combat`).off('value', this._listener);
      if (this._rollsFn && this._rollsRef)
        this._rollsRef.off('child_added', this._rollsFn);
    } catch(e) {}
    this._listener = null; this._rollsRef = null; this._rollsFn = null;
    this._state    = null;
  },

  getState() { return this._state || null; },

  async _write(path, val) {
    if (!FB.db || !FB.roomId) return;
    try {
      const ref = path
        ? FB.db.ref(`rooms/${FB.roomId}/combat/${path}`)
        : FB.db.ref(`rooms/${FB.roomId}/combat`);
      await ref.set(val);
    } catch(e) { console.error('CB._write:', path, e); }
  },

  async _update(path, updates) {
    if (!FB.db || !FB.roomId) return;
    try {
      await FB.db.ref(`rooms/${FB.roomId}/combat/${path}`).update(updates);
    } catch(e) { console.error('CB._update:', path, e); }
  },

  async _push(path, val) {
    if (!FB.db || !FB.roomId) return;
    try {
      await FB.db.ref(`rooms/${FB.roomId}/combat/${path}`).push(val);
    } catch(e) { console.error('CB._push:', path, e); }
  },

  /* ── Turn management ── */
  async nextTurn() {
    const s = this.getState(); if (!s?.active || !FB.isKP) return;
    const order = s.turnOrder || []; if (!order.length) return;
    const curIdx = s.currentActorIndex ?? 0;

    let nextIdx = curIdx; let tries = 0; const skipped = [];
    do {
      nextIdx = (nextIdx + 1) % order.length; tries++;
      // Wrapped around — new round
      if (nextIdx === 0 && tries === 1) {
        const newRound = (s.round || 1) + 1;
        await this._write('round', newRound);
        _cbShowRoundAnnounce(newRound);
      }
      const entry = order[nextIdx];
      const conds = s.participants?.[entry.id]?.conditions || {};
      if (conds.dead)        { continue; }
      if (conds.unconscious || conds.prone) { skipped.push(entry.name); continue; }
      break;
    } while (tries <= order.length);

    if (skipped.length) _cbShowSkipBanner(skipped);
    await this._write('currentActorIndex', nextIdx);

    // Check if all one faction can no longer act
    _cbCheckAllDown(s, order, nextIdx);
  },

  async prevTurn() {
    const s = this.getState(); if (!s?.active || !FB.isKP) return;
    const order = s.turnOrder || []; if (!order.length) return;
    const curIdx = s.currentActorIndex ?? 0;
    const prevIdx = (curIdx - 1 + order.length) % order.length;
    await this._write('currentActorIndex', prevIdx);
  },

  async endCombat() {
    if (!FB.db || !FB.roomId || !FB.isKP) return;
    try { await FB.db.ref(`rooms/${FB.roomId}/combat`).remove(); }
    catch(e) { console.error('CB.endCombat:', e); }
  },

  async applyHpChange(targetId, delta, isCritical) {
    const s = this.getState(); if (!s?.active) return;
    const p = s.participants?.[targetId]; if (!p) return;
    const maxHp = p.maxHp || 1;
    const newHp = Math.max(0, Math.min(maxHp, (p.hp || 0) + delta));
    try {
      await this._write(`participants/${targetId}/hp`, newHp);
      await this._push('hpChanges', {targetId, delta, isCritical: !!isCritical, timestamp: Date.now()});
      _cbShowDmgFloat(targetId, delta, isCritical);
      if (newHp <= 0) {
        const entry = (s.turnOrder || []).find(e => e.id === targetId);
        _cbShowHpZeroAlert(targetId, entry?.name || targetId);
      }
    } catch(e) { console.error('CB.applyHpChange:', e); }
  },

  async setCondition(targetId, condKey, value) {
    try { await this._write(`participants/${targetId}/conditions/${condKey}`, value); }
    catch(e) { console.error('CB.setCondition:', e); }
  },

  async setTerrain(terrain) {
    try { await this._write('terrain', terrain); }
    catch(e) {}
  },

  async setHorizon(y) {
    try { await this._write('horizonY', parseFloat(y)); }
    catch(e) {}
  },

  async setFlipped(id, flipped) {
    try { await this._write(`positions/${id}/flipped`, flipped); }
    catch(e) {}
  },

  async setOffsetY(id, offsetY) {
    try { await this._write(`positions/${id}/offsetY`, parseInt(offsetY) || 0); }
    catch(e) {}
  },

  /* ── Start modal ── */
  openStartModal()  { document.getElementById('cbStartModal')?.classList.add('show');    _cbRenderStartModal(); },
  closeStartModal() { document.getElementById('cbStartModal')?.classList.remove('show'); },

  /* ── Firebase rolls listener (for remote roll result banners) ── */
  _listenRolls() {
    if (!FB.db || !FB.roomId || this._rollsFn) return;
    try {
      this._rollsRef = FB.db.ref(`rooms/${FB.roomId}/channels/general/rolls`);
      // Only get new rolls (not history)
      this._rollsRef.once('value').then(snap => {
        const keys = snap.exists() ? Object.keys(snap.val() || {}) : [];
        const lastKey = keys.length ? keys[keys.length - 1] : null;
        let query = lastKey
          ? this._rollsRef.orderByKey().startAfter(lastKey)
          : this._rollsRef.limitToLast(1);
        this._rollsFn = query.on('child_added', snap => {
          const roll = snap.val(); if (!roll) return;
          const age = Date.now() - (roll.ts || roll.timestamp || 0);
          if (age > 5000) return;  // ignore old rolls
          if (roll.fromSelf || roll.operatorId === FB.playerName) return; // don't double-show own rolls
          if (roll.grade && this.getState()?.active) _cbShowResultBanner(roll.grade, roll.skillName || roll.label || '');
        });
      });
    } catch(e) {}
  },

  /* ── Write combat event ── */
  async writeEvent(actorName, action, result, damage) {
    try {
      await this._push('events', {actorName, action, result, damage: damage||0, timestamp: Date.now()});
    } catch(e) {}
  },

  /* ── Token animation dispatcher ── */
  playAnimation(id, animType) {
    // Block re-renders for 600ms so the animation isn't killed by Firebase's immediate local listener
    this._animBusy = true;
    clearTimeout(this._animBusyTimer);
    this._animBusyTimer = setTimeout(() => { this._animBusy = false; }, 600);
    const tok    = document.getElementById(`cbTok_${id}`); if (!tok) return;
    const inner  = document.getElementById(`cbSi_${id}`);
    const imgEl  = document.getElementById(`cbImg_${id}`);
    const circle = tok.querySelector('.cb-token-circle');
    const hasImg = imgEl && imgEl.src && imgEl.src !== window.location.href;
    if (hasImg) _cbPlaySpriteAnim(tok, inner, imgEl, animType);
    else        _cbPlayCircleAnim(tok, inner, circle, animType);
  },
};

/* ═══════════════════════════════════════════════════════
   renderCombatTab — main entry, called by App.renderTab()
   ═══════════════════════════════════════════════════════ */
function renderCombatTab() {
  const panel = document.getElementById('tab-combat'); if (!panel) return;

  if (!FB.roomId) {
    panel.innerHTML = `<div class="cb-wrap"><div class="cb-empty">
      <div class="cb-empty-icon">⚔</div>
      <div class="cb-empty-text">请先加入房间</div>
    </div></div>`;
    return;
  }

  const s = CB.getState();
  if (!s || !s.active) {
    panel.innerHTML = `<div class="cb-wrap"><div class="cb-empty">
      <div class="cb-empty-icon">⚔</div>
      <div class="cb-empty-text">当前没有进行中的战斗</div>
      ${FB.isKP ? `<button class="cb-start-btn" id="cbStartBtn">⚔ 开始战斗</button>` : ''}
    </div></div>`;
    if (FB.isKP) {
      document.getElementById('cbStartBtn')?.addEventListener('click', () => CB.openStartModal());
    }
    return;
  }

  // Active combat — render full UI
  panel.innerHTML = _cbFullHtml(s);
  _cbApplyDynamicState(s);
  _cbBindCombatUI(s);
}

/* ── Full combat HTML skeleton ── */
function _cbFullHtml(s) {
  const kp = FB.isKP;
  const sidePanels = kp ? `
    ${_cbSidePanelHtml(s, 'left')}
    <div class="cb-battlefield" id="cbBattlefield">
      ${_cbTokenLayerHtml(s)}
      ${_cbResultBannerHtml()}
      ${kp ? _cbHorizonSliderHtml(s) : ''}
    </div>
    ${_cbSidePanelHtml(s, 'right')}
  ` : `
    <div class="cb-battlefield" id="cbBattlefield">
      ${_cbTokenLayerHtml(s)}
      ${_cbResultBannerHtml()}
    </div>
  `;
  return `<div class="cb-wrap">
    ${_cbTopbarHtml(s)}
    <div class="cb-main">${sidePanels}</div>
    ${_cbBottombarHtml(s)}
  </div>`;
}

/* ── Top bar ── */
function _cbTopbarHtml(s) {
  const order   = s.turnOrder || [];
  const curIdx  = s.currentActorIndex ?? 0;
  const round   = s.round || 1;

  const avatarItems = order.map((e, i) => {
    const pc  = KP._playerCards?.[e.id];
    const npc = KP.getNpcs?.()?.find(n => n.id === e.id);
    const av  = pc?.avatar || npc?.avatar || '';
    const nm  = e.name || e.id;
    const cls = i < curIdx ? 'done' : i === curIdx ? 'acting' : '';
    const inner = av
      ? `<img src="${esc(av)}" alt="${esc(nm)}" title="${esc(nm)}">`
      : `<div class="cb-ta-circle" style="background:${_cbNameColor(nm)}" title="${esc(nm)}">${(nm[0]||'?').toUpperCase()}</div>`;
    return `<div class="cb-turn-avatar ${cls}" title="${esc(nm)}">${inner}</div>`;
  }).join('');

  const kpControls = FB.isKP ? `
    <div class="cb-topbar-controls">
      <button class="cb-ctrl-btn" onclick="CB.prevTurn()">◀ 上一位</button>
      <button class="cb-ctrl-btn gold" onclick="CB.nextTurn()">▶ 下一位</button>
      <button class="cb-ctrl-btn danger" onclick="_cbConfirmEnd()">结束战斗</button>
    </div>` : '';

  return `<div class="cb-topbar">
    <div class="cb-topbar-round">第 ${round} 轮</div>
    <div class="cb-turn-list">${avatarItems}</div>
    ${kpControls}
  </div>`;
}

/* ── Battlefield: token layer ── */
function _cbTokenLayerHtml(s) {
  const order     = s.turnOrder     || [];
  const positions = s.positions     || {};
  const parts     = s.participants  || {};
  const horizonY  = s.horizonY      ?? 0.65;
  const curIdx    = s.currentActorIndex ?? 0;
  const npcs      = KP.getNpcs?.() || [];

  const tokens = order.map((e, i) => {
    const pos   = positions[e.id] || {};
    const p     = parts[e.id]     || {};
    const conds = p.conditions    || {};
    const side  = p.side          || (e.isNPC ? 'enemy' : 'ally');

    const isAlly   = side === 'ally' || side === 'friendly';
    const slotArr  = isAlly ? CB_ALLY_X : CB_ENEMY_X;
    const slot     = pos.slot ?? (isAlly ? 0 : 0);
    const xPct     = slotArr[Math.min(slot, slotArr.length - 1)];
    const bottomPct = (horizonY * 100).toFixed(1);
    const offsetY  = pos.offsetY || 0;
    const isActing = i === curIdx;

    // HP
    const hp     = p.hp    ?? null;
    const maxHp  = p.maxHp ?? 1;
    const hpPct  = hp !== null ? Math.max(0, Math.min(100, hp / maxHp * 100)) : 100;
    const hpLow  = hpPct <= 30;
    const showHp = hp !== null;

    // Determine which CSS state classes to apply
    const stateClasses = _cbTokenStateClasses(conds, side, isActing);
    const condDots     = _cbCondDotsHtml(conds);

    // Avatar / sprite
    const pc  = KP._playerCards?.[e.id];
    const npc = npcs.find(n => n.id === e.id);
    const av  = pc?.avatar || npc?.avatar || '';
    const nm  = e.name || e.id;
    const siz = pc?.SIZ || npc?.siz || 50;
    const tokH = Math.max(80, Math.min(220, siz * 3));

    const flipped = pos.flipped ? 'style="transform:scaleX(-1)"' : '';
    const spriteHtml = av
      ? `<div class="cb-sprite-inner" id="cbSi_${esc(e.id)}">
           <img src="${esc(av)}" style="max-height:${tokH}px" ${flipped} id="cbImg_${esc(e.id)}" alt="${esc(nm)}">
         </div>`
      : `<div class="cb-sprite-inner" id="cbSi_${esc(e.id)}">
           <div class="cb-token-circle" style="background:${_cbNameColor(nm)}">${(nm[0]||'?').toUpperCase()}</div>
         </div>`;

    const deadX = conds.dead ? '<div class="cb-token-dead-x">✕</div>' : '';

    const imgSel = av ? `document.getElementById('cbImg_${esc(e.id)}')` : `document.querySelector('#cbSi_${esc(e.id)} .cb-token-circle')`;
    const kpBtns = FB.isKP ? `
      <div class="cb-token-kp">
        <button class="cb-tok-flip" onclick="_cbFlipToken('${esc(e.id)}')">↔</button>
        <div class="cb-tok-offset-wrap">
          <input type="range" min="-60" max="60" value="${offsetY}"
            oninput="var el=${imgSel};if(el)el.style.marginTop=this.value+'px'"
            onchange="CB.setOffsetY('${esc(e.id)}',this.value)">
          <span class="cb-tok-offset-lbl">↕</span>
        </div>
      </div>` : '';

    const hpBar = showHp ? `<div class="cb-token-hp-bar">
      <div class="cb-token-hp-fill${hpLow?' low':''}" style="width:${hpPct.toFixed(1)}%"></div>
    </div>` : '';

    const tokenStyle = `left:${xPct}%;bottom:calc(${bottomPct}% + ${offsetY}px)`;

    return `<div class="cb-token ${stateClasses}" id="cbTok_${esc(e.id)}" style="${tokenStyle}" data-id="${esc(e.id)}">
      <div class="cb-token-arrow">▼</div>
      ${hpBar}
      <div class="cb-sprite-outer">
        ${spriteHtml}
        ${deadX}
        ${kpBtns}
      </div>
      <div class="cb-token-name">${esc(nm)}</div>
      ${condDots}
    </div>`;
  }).join('');

  return `<div class="cb-token-layer">${tokens}</div>`;
}

function _cbResultBannerHtml() {
  return `<div class="cb-result-banner" id="cbResultBanner">
    <div class="cb-result-grade" id="cbResultGrade"></div>
    <div class="cb-result-detail" id="cbResultDetail"></div>
  </div>`;
}

function _cbHorizonSliderHtml(s) {
  const horizonY = s.horizonY ?? 0.65;
  const val = Math.round(horizonY * 100);
  return `<div class="cb-horizon-wrap">
    <input type="range" min="30" max="85" value="${val}"
      oninput="CB.setHorizon(this.value/100);_cbUpdateHorizon(this.value/100)">
  </div>`;
}

/* ── Side panels (KP only) ── */
function _cbSidePanelHtml(s, side) {
  const order    = s.turnOrder    || [];
  const parts    = s.participants || {};
  const curIdx   = s.currentActorIndex ?? 0;
  const isLeft   = side === 'left';
  const title    = isLeft ? '友方' : '敌方/中立';
  const toggleSymbol = isLeft ? '‹' : '›';

  const npcs = KP.getNpcs?.() || [];
  const rows = order
    .filter(e => {
      const p = parts[e.id] || {};
      const es = p.side || (e.isNPC ? 'enemy' : 'ally');
      return isLeft ? (es === 'ally' || es === 'friendly') : (es === 'enemy' || es === 'neutral');
    })
    .map((e, _i, _arr) => {
      const p      = parts[e.id]  || {};
      const pc     = KP._playerCards?.[e.id];
      const npc    = npcs.find(n => n.id === e.id);
      const av     = pc?.avatar || npc?.avatar || '';
      const nm     = e.name || e.id;
      const es     = p.side || (e.isNPC ? 'enemy' : 'ally');
      const isActing = order.indexOf(e) === curIdx;

      // HP visibility: allies visible to all; enemies only visible to KP
      const showReal = isLeft || FB.isKP;
      const hp    = p.hp    ?? (pc ? (pc.HP?.cur ?? 0) : (npc?.hp ?? 0));
      const maxHp = p.maxHp ?? (pc ? (pc.HP?.max ?? 1) : (npc?.hp ?? 1));
      const hpPct = maxHp > 0 ? Math.max(0, Math.min(100, hp / maxHp * 100)) : 0;
      const hpLow = hpPct <= 30;
      const hpStr = showReal ? `${hp}/${maxHp}` : '???';
      const barW  = showReal ? hpPct.toFixed(1) : 100;
      const barCls = showReal && hpLow ? 'low' : (!showReal ? 'enemy-hide' : '');

      const avEl = av
        ? `<img src="${esc(av)}" alt="${esc(nm)}">`
        : `<span style="background:${_cbNameColor(nm)};width:100%;height:100%;display:flex;align-items:center;justify-content:center;border-radius:50%;font-size:11px;font-weight:700">${(nm[0]||'?').toUpperCase()}</span>`;

      return `<div class="cb-char-row${isActing?' acting':''}">
        <div class="cb-char-av">${avEl}</div>
        <div class="cb-char-info">
          <div class="cb-char-nm">${esc(nm)}</div>
          <div class="cb-char-hp-row">
            <div class="cb-char-hp-track"><div class="cb-char-hp-fill${hpLow&&showReal?' low':''}" style="width:${barW}%;background:${!showReal?'rgba(100,100,120,.4)':''}"></div></div>
            <span class="cb-char-hp-nums${hpLow&&showReal?' low':''}">${hpStr}</span>
          </div>
        </div>
      </div>`;
    }).join('');

  return `<div class="cb-sidepanel ${side}" id="cbSide_${side}">
    <div class="cb-side-toggle" onclick="this.closest('.cb-sidepanel').classList.toggle('collapsed')">${toggleSymbol}</div>
    <div class="cb-side-inner">
      <div class="cb-side-title">${title}</div>
      <div class="cb-side-rows">${rows || '<div style="padding:8px;font-size:11px;color:var(--dim)">无</div>'}</div>
    </div>
  </div>`;
}

/* ── Bottom bar ── */
function _cbBottombarHtml(s) {
  const order   = s.turnOrder || [];
  const curIdx  = s.currentActorIndex ?? 0;
  const actor   = order[curIdx];
  const parts   = s.participants || {};
  const npcs    = KP.getNpcs?.() || [];

  if (!actor) return `<div class="cb-bottombar" id="cbBottombar"></div>`;

  // Determine visibility: KP always, player only if it's their character
  const isMyTurn = FB.isKP || actor.id === FB.playerName;
  const showBar  = isMyTurn;

  const pc  = KP._playerCards?.[actor.id];
  const npc = npcs.find(n => n.id === actor.id);
  const av  = pc?.avatar || npc?.avatar || '';
  const nm  = actor.name || actor.id;
  const dex = actor.dex || 0;

  const avHtml = av
    ? `<img src="${esc(av)}" alt="${esc(nm)}">`
    : `<span style="background:${_cbNameColor(nm)}">${(nm[0]||'?').toUpperCase()}</span>`;

  // HP target: all except actor
  const hpTargetOpts = order
    .filter(e => e.id !== actor.id)
    .map(e => `<option value="${esc(e.id)}">${esc(e.name || e.id)}</option>`).join('');

  // Condition target: all including actor
  const condTargetOpts = order
    .map(e => `<option value="${esc(e.id)}">${esc(e.name || e.id)}</option>`).join('');

  const condOpts = CB_CONDITIONS.map(c =>
    `<option value="${c.key}">${c.label}</option>`).join('');

  const kpCondSection = FB.isKP ? `
    <div class="cb-vdivider"></div>
    <div class="cb-bb-zone">
      <span class="cb-bb-lbl">目标：</span>
      <select class="cb-bb-sel" id="cbCondTargetSel"><option value="">— 选择 —</option>${condTargetOpts}</select>
      <span class="cb-bb-lbl">状态：</span>
      <select class="cb-bb-cond" id="cbCondSel">${condOpts}</select>
      <button class="cb-bb-apply" onclick="_cbApplyCondition()">标记</button>
    </div>` : '';

  return `<div class="cb-bottombar${showBar?' show':''}" id="cbBottombar">
    <div class="cb-bb-actor">
      <div class="cb-bb-av">${avHtml}</div>
      <div class="cb-bb-info">
        <div class="cb-bb-name">${esc(nm)}</div>
        <div class="cb-bb-dex">DEX ${dex}</div>
      </div>
    </div>
    <div class="cb-vdivider"></div>
    <div class="cb-bb-zone">
      <span class="cb-bb-lbl">目标：</span>
      <select class="cb-bb-sel" id="cbHpTargetSel"><option value="">— 选择 —</option>${hpTargetOpts}</select>
      <span class="cb-bb-lbl">数值：</span>
      <input type="number" class="cb-bb-num" id="cbDeltaInput" value="-1">
      <button class="cb-bb-apply" onclick="_cbApplyHpChange()">应用变化</button>
    </div>
    ${kpCondSection}
    <button class="cb-bb-next" onclick="CB.nextTurn()">▶ 下一位</button>
  </div>`;
}

/* ── Apply dynamic state after render ── */
function _cbApplyDynamicState(s) {
  const bf = document.getElementById('cbBattlefield'); if (!bf) return;
  const terrain = s.terrain || 'indoor';
  bf.className = `cb-battlefield terrain-${terrain}`;
}

/* ── Bind all combat UI events ── */
function _cbBindCombatUI(s) {
  // Nothing extra to bind — inline handlers handle most interactions
}

/* ═══════════════════════════════════════════════════════
   Inline-handler helper functions (called via HTML onclick)
   ═══════════════════════════════════════════════════════ */

function _cbFlipToken(id) {
  const inner = document.getElementById(`cbSi_${id}`);
  if (!inner) return;
  const img = inner.querySelector('img') || inner.querySelector('.cb-token-circle');
  if (!img) return;
  const wasFlipped = inner.dataset.flipped === '1';
  const nowFlipped = !wasFlipped;
  inner.dataset.flipped = nowFlipped ? '1' : '0';
  if (img.tagName === 'IMG') {
    img.style.transform = nowFlipped ? 'scaleX(-1)' : '';
  }
  CB.setFlipped(id, nowFlipped);
}


function _cbUpdateHorizon(y) {
  // Reposition all tokens when horizon changes without full re-render
  const s = CB.getState(); if (!s?.turnOrder) return;
  const pos = s.positions || {};
  const bottomPct = (y * 100).toFixed(1);
  s.turnOrder.forEach(e => {
    const tok = document.getElementById(`cbTok_${e.id}`); if (!tok) return;
    const offsetY = pos[e.id]?.offsetY || 0;
    tok.style.bottom = `calc(${bottomPct}% + ${offsetY}px)`;
  });
}

function _cbApplyHpChange() {
  const s      = CB.getState();
  const order  = s?.turnOrder || [];
  const curIdx = s?.currentActorIndex ?? 0;
  const actor  = order[curIdx];
  const targetId = document.getElementById('cbHpTargetSel')?.value;
  const delta    = parseInt(document.getElementById('cbDeltaInput')?.value) || 0;
  if (!targetId) return;
  if (delta === 0) {
    if (actor) CB.playAnimation(actor.id, 'attack');
    CB.playAnimation(targetId, 'dodge');
    _cbShowMissFloat(targetId);
    const targetName = order.find(e => e.id === targetId)?.name || targetId;
    CB.writeEvent(actor?.name || 'KP', `攻击 ${targetName}`, '未命中', 0);
    return;
  }
  if (actor && actor.id !== targetId) CB.playAnimation(actor.id, 'attack');
  if (delta < 0) CB.playAnimation(targetId, 'hit');
  CB.applyHpChange(targetId, delta, false);
}

function _cbApplyCondition() {
  const targetId = document.getElementById('cbCondTargetSel')?.value;
  const condKey  = document.getElementById('cbCondSel')?.value;
  if (!targetId || !condKey) return;
  CB.setCondition(targetId, condKey, true);
  CB.writeEvent('KP', `标记${targetId}`, condKey, 0);
  if (condKey === 'dead')                                    CB.playAnimation(targetId, 'death');
  else if (condKey === 'unconscious' || condKey === 'prone') CB.playAnimation(targetId, 'unconscious');
  else if (condKey === 'insane')                             CB.playAnimation(targetId, 'insane');
}

function _cbConfirmEnd() {
  if (confirm('确认结束战斗？')) CB.endCombat();
}

/* ═══════════════════════════════════════════════════════
   Token helpers
   ═══════════════════════════════════════════════════════ */
function _cbTokenStateClasses(conds, side, isActing) {
  const classes = [side]; // 'ally' | 'enemy' | 'neutral'
  if (isActing)                classes.push('acting');
  if (conds.dead)              { classes.push('dead'); return classes.join(' '); }
  if (conds.insane)            classes.push('insane');
  if (conds.unconscious)       classes.push('unconscious');
  else if (conds.prone)        classes.push('prone');
  if (conds.severelyInjured)   classes.push('severelyInjured');
  else if (conds.injured)      classes.push('injured');
  return classes.join(' ');
}

function _cbCondDotsHtml(conds) {
  const active = CB_CONDITIONS.filter(c => conds[c.key]);
  if (!active.length) return '';
  const dots = active.map(c => `<span class="cb-token-cond" title="${esc(c.label)}">${c.label}</span>`).join('');
  return `<div class="cb-token-conds">${dots}</div>`;
}

function _cbNameColor(name) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) & 0xffffff;
  return `hsl(${h % 360},50%,35%)`;
}

/* ═══════════════════════════════════════════════════════
   Start modal
   ═══════════════════════════════════════════════════════ */
function _cbRenderStartModal() {
  const cont = document.getElementById('cbModalContent'); if (!cont) return;
  const npcs      = KP.getNpcs?.() || [];
  const onlineIds = KP._onlineIds ? [...KP._onlineIds] : [];

  const factSel = (id, def) =>
    `<select id="cbfact_${id}" style="font-size:11px;padding:2px 4px;background:var(--surface4);border:1px solid var(--border-bright);border-radius:4px;color:var(--text)">
      <option value="ally"${def==='ally'?' selected':''}>友方</option>
      <option value="neutral"${def==='neutral'?' selected':''}>中立</option>
      <option value="enemy"${def==='enemy'?' selected':''}>敌对</option>
    </select>`;

  const playerRows = onlineIds.map(pid => {
    const pc = KP._playerCards?.[pid] || {};
    const nm = pc.characterName || pc.name || pid;
    const dex = pc.DEX || pc.dex || 10;
    return `<div class="cb-participant-row">
      <input type="checkbox" id="cbp_${pid}" value="${esc(pid)}" checked data-type="player">
      <label for="cbp_${pid}">${esc(nm)} <span style="color:var(--dim);font-size:10px">(玩家)</span></label>
      <div class="cb-participant-dex">DEX<input type="number" id="cbdex_${pid}" value="${dex}" min="1" max="99"></div>
      ${factSel(pid, 'ally')}
    </div>`;
  }).join('');

  const npcRows = npcs.map(npc => `<div class="cb-participant-row">
    <input type="checkbox" id="cbp_${npc.id}" value="${esc(npc.id)}" data-type="npc" data-npcname="${esc(npc.name)}">
    <label for="cbp_${npc.id}">${esc(npc.name)} <span style="color:var(--dim);font-size:10px">(NPC)</span></label>
    <div class="cb-participant-dex">DEX<input type="number" id="cbdex_${npc.id}" value="${npc.dex||10}" min="1" max="99"></div>
    ${factSel(npc.id, 'enemy')}
  </div>`).join('');

  const terrainOpts = Object.entries(CB_TERRAIN_LABELS)
    .map(([t, l]) => `<button class="cb-terrain-btn${t==='indoor'?' active':''}" data-terrain="${t}">${l}</button>`).join('');

  cont.innerHTML = `
    <div class="cb-modal-section">选择参战角色（DEX 降序行动）</div>
    <div class="cb-participant-list">
      ${playerRows || '<div style="color:var(--dim);font-size:12px;padding:6px">暂无在线玩家</div>'}
      ${npcRows}
    </div>
    <div class="cb-modal-section" style="margin-top:8px">战场背景</div>
    <div class="cb-modal-terrain">${terrainOpts}</div>`;

  cont.querySelectorAll('.cb-terrain-btn').forEach(b => {
    b.addEventListener('click', () => {
      cont.querySelectorAll('.cb-terrain-btn').forEach(x => x.classList.remove('active'));
      b.classList.add('active');
    });
  });
}

function _cbBindStartModal() {
  document.getElementById('cbModalCancel')?.addEventListener('click', () => CB.closeStartModal());
  document.getElementById('cbModalConfirm')?.addEventListener('click', _cbConfirmStart);
}

async function _cbConfirmStart() {
  const cont = document.getElementById('cbModalContent'); if (!cont) return;
  const terrain   = cont.querySelector('.cb-terrain-btn.active')?.dataset.terrain || 'indoor';
  const entries   = [];
  const npcs      = KP.getNpcs?.() || [];

  cont.querySelectorAll('input[type=checkbox][data-type]').forEach(cb => {
    if (!cb.checked) return;
    const id   = cb.value;
    const type = cb.dataset.type;
    const pc   = KP._playerCards?.[id] || {};
    const npc  = npcs.find(n => n.id === id) || {};
    const name = type === 'player' ? (pc.characterName || pc.name || id) : (cb.dataset.npcname || id);
    const dex  = parseInt(document.getElementById(`cbdex_${id}`)?.value) || 10;
    const faction = document.getElementById(`cbfact_${id}`)?.value || (type === 'player' ? 'ally' : 'enemy');
    entries.push({id, type, name, dex, tieBreakRoll: Math.floor(Math.random() * 100) + 1, faction});
  });

  if (!entries.length) { alert('请至少选择一名参战角色'); return; }

  // Sort by DEX desc; ties resolved by lower tieBreakRoll wins
  entries.sort((a, b) => b.dex !== a.dex ? b.dex - a.dex : a.tieBreakRoll - b.tieBreakRoll);

  // Assign slots
  const positionsObj = {}; let allySlot = 0, enemySlot = 0;
  entries.forEach(e => {
    const isAlly = e.faction === 'ally' || e.faction === 'friendly';
    positionsObj[e.id] = {
      slot:    isAlly ? Math.min(allySlot, CB_ALLY_X.length - 1) : Math.min(enemySlot, CB_ENEMY_X.length - 1),
      flipped: !isAlly,  // enemies face left by default
      offsetY: 0,
    };
    if (isAlly) allySlot++; else enemySlot++;
  });

  // Build participants with current HP
  const participantsObj = {};
  entries.forEach(e => {
    const pc  = KP._playerCards?.[e.id];
    const npc = npcs.find(n => n.id === e.id);
    const hp    = pc ? (pc.HP?.cur ?? 0) : (npc?.hp ?? 10);
    const maxHp = pc ? (pc.HP?.max ?? 1) : (npc?.hp ?? 10);
    const san   = pc ? (pc.SAN?.cur ?? 0) : (npc?.san ?? 0);
    const maxSan = pc ? (pc.SAN?.max ?? 1) : (npc?.san ?? 0);
    let side = e.faction || (e.type === 'player' ? 'ally' : 'enemy');
    if (side === 'friendly') side = 'ally';
    participantsObj[e.id] = {side, hp, maxHp, san, maxSan, conditions: {}};
  });

  const combatData = {
    active: true, round: 1, currentActorIndex: 0,
    terrain, horizonY: 0.65,
    turnOrder:    entries,
    positions:    positionsObj,
    participants: participantsObj,
    events:       {},
    startedAt:    Date.now(),
  };

  try {
    await CB._write('', combatData);
    CB.closeStartModal();
    // Round 1 announce
    setTimeout(() => _cbShowRoundAnnounce(1), 400);
  } catch(e) { console.error('Combat start failed:', e); alert('启动战斗失败，请重试'); }
}

/* ═══════════════════════════════════════════════════════
   Animations & overlays
   ═══════════════════════════════════════════════════════ */

function _cbPlaySpriteAnim(tok, inner, imgEl, animType) {
  const isAlly = tok.classList.contains('ally');
  const _after = (el, ms) => setTimeout(() => { el.style.animation = ''; }, ms);
  switch (animType) {
    case 'hit':
      if (imgEl) {
        imgEl.style.transition = 'filter 0.05s';
        imgEl.style.filter = 'brightness(4) sepia(1) hue-rotate(-20deg) saturate(5)';
        setTimeout(() => { imgEl.style.filter = ''; imgEl.style.transition = ''; }, 200);
      }
      if (inner) { inner.style.animation = 'cbHitShake 0.4s ease'; _after(inner, 450); }
      break;
    case 'dodge':
      if (inner) { inner.style.animation = 'cbDodge 0.4s ease'; _after(inner, 450); }
      break;
    case 'attack':
      if (inner) { inner.style.animation = `${isAlly ? 'cbAttackRight' : 'cbAttackLeft'} 0.4s ease`; _after(inner, 450); }
      break;
    case 'death':
      if (imgEl) { imgEl.style.transition = 'filter 0.8s, opacity 0.8s'; imgEl.style.filter = 'grayscale(1)'; imgEl.style.opacity = '0.5'; }
      break;
    case 'unconscious':
      if (inner) { inner.style.transition = 'transform 0.5s'; inner.style.transform = 'rotate(80deg)'; }
      break;
    case 'insane':
      if (inner) { inner.style.animation = 'cbInsaneShake 0.5s ease'; _after(inner, 550); }
      break;
  }
}

function _cbPlayCircleAnim(tok, inner, circle, animType) {
  const isAlly = tok.classList.contains('ally');
  const _after = (el, ms) => setTimeout(() => { el.style.animation = ''; }, ms);
  switch (animType) {
    case 'hit':
      if (inner) { inner.style.animation = 'cbHitShake 0.4s ease'; _after(inner, 450); }
      if (circle) {
        const orig = circle.style.background;
        circle.style.transition = 'background 0.05s';
        circle.style.background = '#e74c3c';
        setTimeout(() => { circle.style.background = orig; circle.style.transition = ''; }, 250);
      }
      break;
    case 'dodge':
      if (inner) { inner.style.animation = 'cbDodge 0.4s ease'; _after(inner, 450); }
      break;
    case 'attack':
      if (inner) { inner.style.animation = `${isAlly ? 'cbAttackRight' : 'cbAttackLeft'} 0.4s ease`; _after(inner, 450); }
      break;
    case 'death':
      if (circle) { circle.style.transition = 'filter 0.8s, opacity 0.8s, transform 0.8s'; circle.style.filter = 'grayscale(1)'; circle.style.opacity = '0.4'; circle.style.transform = 'scale(0.7)'; }
      break;
    case 'unconscious':
      if (inner) { inner.style.transition = 'transform 0.5s'; inner.style.transform = 'rotate(90deg)'; }
      break;
    case 'insane':
      if (inner) { inner.style.animation = 'cbInsaneShake 0.5s ease'; _after(inner, 550); }
      break;
  }
}

function _cbShowMissFloat(targetId) {
  const tok = document.getElementById(`cbTok_${targetId}`); if (!tok) return;
  const bf  = document.getElementById('cbBattlefield'); if (!bf) return;
  const rect   = tok.getBoundingClientRect();
  const bfRect = bf.getBoundingClientRect();
  const el = document.createElement('div');
  el.className = 'cb-float-miss';
  el.style.left = `${rect.left - bfRect.left + rect.width / 2}px`;
  el.style.top  = `${rect.top  - bfRect.top}px`;
  el.textContent = 'MISS';
  bf.appendChild(el);
  setTimeout(() => el.remove(), 1500);
}

function _cbShowRoundAnnounce(round) {
  const el  = document.getElementById('cbRoundAnnounce');
  const txt = document.getElementById('cbAnnounceText');
  const sub = document.getElementById('cbAnnounceSub');
  if (!el) return;
  if (txt) txt.textContent = `第 ${round} 轮`;
  if (sub) sub.textContent = `ROUND ${round}`;
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 2200);
}

function _cbShowYourTurn() {
  // Mount inside #tab-combat so it's hidden when the tab is not active
  const panel = document.getElementById('tab-combat');
  if (!panel || !panel.classList.contains('active')) return;
  clearTimeout(CB._yourTurnTimer);
  document.querySelectorAll('.cb-your-turn').forEach(e => e.remove());
  const el = document.createElement('div');
  el.className = 'cb-your-turn'; el.textContent = '轮到你行动了！';
  panel.appendChild(el);
  CB._yourTurnTimer = setTimeout(() => el.remove(), 3000);
}

function _cbShowSkipBanner(names) {
  const bf = document.getElementById('cbBattlefield'); if (!bf) return;
  const existing = bf.querySelector('.cb-skip-banner');
  if (existing) existing.remove();
  const el = document.createElement('div');
  el.className = 'cb-skip-banner';
  el.textContent = `${names.join('、')} 跳过回合`;
  bf.appendChild(el);
  setTimeout(() => el.remove(), 2500);
}

function _cbShowDmgFloat(targetId, delta, isCritical) {
  const tok = document.getElementById(`cbTok_${targetId}`); if (!tok) return;
  const rect  = tok.getBoundingClientRect();
  const bf    = document.getElementById('cbBattlefield'); if (!bf) return;
  const bfRect = bf.getBoundingClientRect();

  const el = document.createElement('div');
  const cls = isCritical ? 'crit' : (delta < 0 ? 'neg' : 'pos');
  el.className = `cb-float-dmg ${cls}`;
  el.style.left = `${rect.left - bfRect.left + rect.width / 2}px`;
  el.style.top  = `${rect.top  - bfRect.top}px`;

  const critLabel = isCritical ? '<div class="cb-float-crit-lbl">CRITICAL!</div>' : '';
  el.innerHTML = `${critLabel}<div class="cb-float-val">${delta > 0 ? '+' : ''}${delta}</div>`;
  bf.appendChild(el);
  setTimeout(() => el.remove(), 1500);
}

function _cbShowHpZeroAlert(targetId, name) {
  const bf = document.getElementById('cbBattlefield'); if (!bf) return;
  const existing = document.getElementById('cbHpZero'); if (existing) existing.remove();
  if (!FB.isKP) return; // only KP gets the choose-state prompt

  const el = document.createElement('div');
  el.className = 'cb-hp-zero'; el.id = 'cbHpZero';
  el.innerHTML = `<div class="cb-hp-zero-title">${esc(name)} HP 归零，请选择状态：</div>
    <div class="cb-hp-zero-btns">
      <button class="cb-hp-zero-btn" onclick="CB.setCondition('${esc(targetId)}','unconscious',true);this.closest('.cb-hp-zero').remove()">昏迷</button>
      <button class="cb-hp-zero-btn" onclick="CB.setCondition('${esc(targetId)}','prone',true);this.closest('.cb-hp-zero').remove()">倒地</button>
      <button class="cb-hp-zero-btn" onclick="this.closest('.cb-hp-zero').remove()">濒死</button>
      <button class="cb-hp-zero-btn" onclick="CB.setCondition('${esc(targetId)}','dead',true);this.closest('.cb-hp-zero').remove()" style="color:#e74c3c">死亡</button>
    </div>`;
  bf.appendChild(el);
}

function _cbShowResultBanner(grade, detail) {
  const el = document.getElementById('cbResultBanner'); if (!el) return;
  const gradeEl  = document.getElementById('cbResultGrade');
  const detailEl = document.getElementById('cbResultDetail');
  const color = CB_GRADE_COLORS[grade] || '#fff';
  const size  = CB_GRADE_SIZES[grade]  || '48px';

  if (gradeEl)  { gradeEl.textContent = grade; gradeEl.style.color = color; gradeEl.style.fontSize = size; }
  if (detailEl) { detailEl.textContent = detail; }
  el.classList.add('show');

  // Full-screen red flash on fumble
  if (grade === '大失败') {
    const bf = document.getElementById('cbBattlefield');
    if (bf) {
      bf.style.animation = 'none';
      void bf.offsetWidth;
      bf.style.animation = 'cbRedFlash 1.5s ease forwards';
      setTimeout(() => { bf.style.animation = ''; }, 1600);
    }
  }

  clearTimeout(_cbResultBannerTimer);
  _cbResultBannerTimer = setTimeout(() => el.classList.remove('show'), 3000);
}
let _cbResultBannerTimer = null;

function _cbCheckAllDown(s, order, newIdx) {
  const parts = s.participants || {};
  const allyDown  = order.filter(e => (parts[e.id]?.side || 'ally') === 'ally')
                         .every(e => { const c = parts[e.id]?.conditions || {}; return c.dead || c.unconscious || c.prone; });
  const enemyDown = order.filter(e => (parts[e.id]?.side || 'enemy') !== 'ally')
                         .every(e => { const c = parts[e.id]?.conditions || {}; return c.dead || c.unconscious || c.prone; });
  if ((allyDown || enemyDown) && FB.isKP) {
    const side = allyDown ? '友方' : '敌方';
    if (confirm(`${side}全部无法行动，是否结束战斗？`)) {
      CB.endCombat();
    }
  }
}

/* ═══════════════════════════════════════════════════════
   Roll result hooks — called from index.html S.pushHist hook
   ═══════════════════════════════════════════════════════ */
function _cbOnRollResult(e) {
  const s = CB.getState(); if (!s?.active) return;
  const detail = `${e.skillName || e.label || '判定'} — 投出 ${e.total}`;
  _cbShowResultBanner(e.grade, detail);

  // Auto-return to combat tab 2s after roll
  setTimeout(() => document.querySelector('[data-tab="combat"]')?.click(), 2000);

  // Log event
  const order   = s.turnOrder || [];
  const curIdx  = s.currentActorIndex ?? 0;
  const actor   = order[curIdx];
  CB.writeEvent(actor?.name || e.charName || '?', e.skillName || e.label || '判定', e.grade, 0);
}

function _cbOnDamageResult(e) {
  const s = CB.getState(); if (!s?.active) return;
  // Show floating +total near current actor token
  const order  = s.turnOrder || [];
  const curIdx = s.currentActorIndex ?? 0;
  const actor  = order[curIdx];
  if (actor) _cbShowDmgFloat(actor.id, -e.total, false);
}

/* ── Also listen for judgeComplete custom event (dispatched by dice tab if wired up) ── */
document.addEventListener('judgeComplete', e => {
  const s = CB.getState(); if (!s?.active) return;
  const {result, judgementLevel, damage} = e.detail || {};
  if (result) _cbShowResultBanner(result, judgementLevel || '');
  if (damage && e.detail.targetId) _cbShowDmgFloat(e.detail.targetId, -damage, judgementLevel === '大成功');
});
