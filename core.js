/*
 * GiftXchange core — общая бизнес-логика.
 * Один и тот же файл используется:
 *   • сервером (server.js) — источник правды, все проверки;
 *   • мини-приложением в демо-режиме — чтобы демо вело себя как настоящий сервер.
 *
 * База данных — обычный объект (db), сервер хранит его в db.json.
 */
(function (root) {
  'use strict';

  const FEE_STARS = 50;
  const RELAYER = 'GiftXchangeRelayer';
  const BOT = 'GiftXchangebot';

  const err = (msg, code = 400) => Object.assign(new Error(msg), { code });
  const now = () => Date.now();

  function newDb() {
    return { v: 1, seq: 1, users: {}, gifts: {}, offers: {}, deposits: {}, withdrawals: {} };
  }
  const nextId = (db, p) => p + (db.seq++).toString(36) + Math.random().toString(36).slice(2, 6);

  /* ---------- Ссылки на подарки ---------- */
  // Поддерживает: https://t.me/nft/PlushPepe-1, t.me/nft/PlushPepe-1, nft.fragment.com/gift/plushpepe-1(.webp)
  function parseLink(input) {
    const s = String(input || '').trim();
    const m = s.match(/(?:t\.me\/nft\/|telegram\.me\/nft\/|(?:www\.)?fragment\.com\/gift\/)([A-Za-z0-9]+)-(\d+)/i)
           || s.match(/^([A-Za-z][A-Za-z0-9]+)-(\d+)$/);
    if (!m) return null;
    const collection = m[1];
    const number = parseInt(m[2], 10);
    if (!number || number < 1 || number > 10_000_000) return null;
    const name = (collection[0].toUpperCase() + collection.slice(1)).replace(/([a-z])([A-Z])/g, '$1 $2').replace(/([A-Za-z])(\d)/g, '$1 $2');
    return {
      slug: collection + '-' + number,
      key: (collection + '-' + number).toLowerCase(),
      collection, number, name,
      link: 'https://t.me/nft/' + collection + '-' + number,
      image: 'https://nft.fragment.com/gift/' + collection.toLowerCase() + '-' + number + '.webp'
    };
  }

  /* ---------- Пользователи ---------- */
  function upsertUser(db, u) {
    if (!u || !u.id) throw err('Нет пользователя', 401);
    const id = String(u.id);
    const prev = db.users[id] || { id, createdAt: now() };
    db.users[id] = Object.assign(prev, {
      id,
      name: [u.first_name, u.last_name].filter(Boolean).join(' ') || u.name || prev.name || 'Пользователь',
      username: u.username || prev.username || null,
      photo: u.photo_url || u.photo || prev.photo || null,
      seenAt: now()
    });
    return db.users[id];
  }
  function findUser(db, q) {
    const s = String(q || '').trim().replace(/^@/, '').replace(/^https?:\/\/t\.me\//i, '');
    if (!s) return null;
    if (/^\d+$/.test(s) && db.users[s]) return db.users[s];
    return Object.values(db.users).find(u => u.username && u.username.toLowerCase() === s.toLowerCase()) || null;
  }
  const pubUser = u => u ? { id: u.id, name: u.name, username: u.username, photo: u.photo } : { id: '0', name: 'Неизвестно' };

  /* ---------- Подарки ---------- */
  const activeGiftByKey = (db, key) => Object.values(db.gifts).find(g => g.key === key && g.status !== 'withdrawn');
  const pendingOffers = db => Object.values(db.offers).filter(o => o.status === 'pending');
  const lockedSet = db => new Set(pendingOffers(db).flatMap(o => o.give)); // подарки, обещанные в исходящих заявках

  function registerGift(db, parsed, ownerId, meta) {
    if (activeGiftByKey(db, parsed.key)) throw err('Этот подарок уже зарегистрирован');
    const g = {
      id: nextId(db, 'g'), key: parsed.key, slug: parsed.slug, link: parsed.link,
      name: (meta && meta.name) || parsed.name, number: parsed.number,
      image: (meta && meta.image) || parsed.image,
      model: meta && meta.model || null, backdrop: meta && meta.backdrop || null, symbol: meta && meta.symbol || null,
      ownerId: String(ownerId), status: 'available', addedAt: now(), history: [{ t: now(), e: 'deposit', u: String(ownerId) }]
    };
    db.gifts[g.id] = g;
    return g;
  }
  function giftView(db, g, locked) {
    return {
      id: g.id, slug: g.slug, link: g.link, name: g.name, number: g.number, image: g.image,
      model: g.model, backdrop: g.backdrop, symbol: g.symbol, status: g.status,
      locked: !!(locked && locked.has(g.id)), addedAt: g.addedAt, owner: pubUser(db.users[g.ownerId])
    };
  }
  // Отменяет все активные заявки, где участвует подарок
  function cancelOffersWith(db, giftIds, except, reason) {
    const set = new Set(giftIds); let n = 0;
    pendingOffers(db).forEach(o => {
      if (o.id !== except && [...o.give, ...o.get].some(id => set.has(id))) { o.status = 'cancelled'; o.auto = true; o.reason = reason || 'Подарок больше недоступен'; o.closedAt = now(); n++; }
    });
    return n;
  }

  /* ---------- Действия ---------- */
  const A = {};

  // Пользователь: «Я отправил подарок на @GiftXchangeRelayer, вот ссылка»
  A.createDeposit = (db, ctx, { link, meta }) => {
    const p = parseLink(link);
    if (!p) throw err('Не похоже на ссылку на NFT-подарок. Пример: https://t.me/nft/PlushPepe-1');
    if (activeGiftByKey(db, p.key)) throw err('Этот подарок уже зарегистрирован в обменнике');
    // Несколько людей могут заявить один подарок — админ подтвердит того, от кого он реально пришёл
    if (Object.values(db.deposits).some(d => d.key === p.key && d.status === 'pending' && d.userId === ctx.uid)) throw err('Вы уже отправили этот подарок на проверку');
    const mine = Object.values(db.deposits).filter(d => d.userId === ctx.uid && d.status === 'pending').length;
    if (mine >= 20) throw err('Слишком много заявок на проверке');
    const d = { id: nextId(db, 'd'), key: p.key, slug: p.slug, link: p.link, name: (meta && meta.name) || p.name, number: p.number,
      image: (meta && meta.image) || p.image, meta: meta || null, userId: ctx.uid, status: 'pending', createdAt: now() };
    db.deposits[d.id] = d;
    return d;
  };
  A.cancelDeposit = (db, ctx, { id }) => {
    const d = db.deposits[id];
    if (!d || d.userId !== ctx.uid) throw err('Заявка не найдена', 404);
    if (d.status !== 'pending') throw err('Заявка уже обработана');
    d.status = 'cancelled'; d.closedAt = now();
  };

  // Админ (@GiftXchangeRelayer): подтверждает, что подарок пришёл от этого пользователя
  A.approveDeposit = (db, ctx, { id }) => {
    needAdmin(ctx);
    const d = db.deposits[id];
    if (!d || d.status !== 'pending') throw err('Заявка не найдена или уже обработана', 404);
    const g = registerGift(db, parseLink(d.link), d.userId, d.meta || { name: d.name, image: d.image });
    d.status = 'approved'; d.giftId = g.id; d.closedAt = now(); d.by = ctx.uid;
    Object.values(db.deposits).forEach(x => { if (x !== d && x.key === d.key && x.status === 'pending') { x.status = 'rejected'; x.reason = 'Подарок пришёл от другого пользователя'; x.closedAt = now(); } });
    return g;
  };
  A.rejectDeposit = (db, ctx, { id, reason }) => {
    needAdmin(ctx);
    const d = db.deposits[id];
    if (!d || d.status !== 'pending') throw err('Заявка не найдена или уже обработана', 404);
    d.status = 'rejected'; d.reason = String(reason || '').slice(0, 200) || null; d.closedAt = now(); d.by = ctx.uid;
  };
  // Админ: регистрирует полученный подарок вручную и указывает владельца
  A.adminRegister = (db, ctx, { link, owner, meta }) => {
    needAdmin(ctx);
    const p = parseLink(link);
    if (!p) throw err('Неверная ссылка на подарок');
    const u = findUser(db, owner);
    if (!u) throw err('Пользователь не найден. Он должен хотя бы раз открыть мини-приложение @' + BOT);
    const g = registerGift(db, p, u.id, meta);
    // если у владельца была заявка на этот подарок — закрываем её
    Object.values(db.deposits).forEach(d => { if (d.key === p.key && d.status === 'pending') { d.status = d.userId === u.id ? 'approved' : 'rejected'; d.giftId = g.id; d.closedAt = now(); } });
    return g;
  };

  // Обмены
  A.createOffer = (db, ctx, { give, get, comment }) => {
    give = [...new Set(give || [])]; get = [...new Set(get || [])];
    if (!give.length || !get.length) throw err('Выберите подарки для обмена');
    if (give.length > 10 || get.length > 10) throw err('Слишком много подарков в одной заявке');
    const locked = lockedSet(db);
    const giveG = give.map(id => db.gifts[id]), getG = get.map(id => db.gifts[id]);
    if (giveG.some(g => !g || g.ownerId !== ctx.uid || g.status !== 'available')) throw err('Часть ваших подарков недоступна');
    if (giveG.some(g => locked.has(g.id))) throw err('Часть ваших подарков уже участвует в другой заявке');
    if (getG.some(g => !g || g.status !== 'available')) throw err('Подарок больше недоступен');
    const toId = getG[0].ownerId;
    if (toId === ctx.uid) throw err('Нельзя меняться с самим собой');
    if (getG.some(g => g.ownerId !== toId)) throw err('Все запрашиваемые подарки должны быть у одного владельца');
    if (getG.some(g => locked.has(g.id))) throw err('Этот подарок сейчас в другой сделке');
    if (pendingOffers(db).some(o => o.fromId === ctx.uid && o.get.some(id => get.includes(id)))) throw err('Вы уже отправили заявку на этот подарок');
    const o = { id: nextId(db, 'o'), fromId: ctx.uid, toId, give, get, comment: String(comment || '').slice(0, 140), status: 'pending', createdAt: now() };
    db.offers[o.id] = o;
    return o;
  };
  A.acceptOffer = (db, ctx, { id }) => {
    const o = db.offers[id];
    if (!o || o.toId !== ctx.uid) throw err('Заявка не найдена', 404);
    if (o.status !== 'pending') throw err('Заявка уже неактуальна');
    const ok = o.give.every(gid => db.gifts[gid] && db.gifts[gid].ownerId === o.fromId && db.gifts[gid].status === 'available')
            && o.get.every(gid => db.gifts[gid] && db.gifts[gid].ownerId === o.toId && db.gifts[gid].status === 'available');
    if (!ok) { o.status = 'cancelled'; o.auto = true; o.reason = 'Подарок больше недоступен'; o.closedAt = now(); throw err('Подарки из заявки больше недоступны, заявка отменена'); }
    o.give.forEach(gid => { const g = db.gifts[gid]; g.ownerId = o.toId; g.history.push({ t: now(), e: 'swap', u: o.toId, o: o.id }); });
    o.get.forEach(gid => { const g = db.gifts[gid]; g.ownerId = o.fromId; g.history.push({ t: now(), e: 'swap', u: o.fromId, o: o.id }); });
    o.status = 'accepted'; o.closedAt = now();
    o.cancelledOthers = cancelOffersWith(db, [...o.give, ...o.get], o.id, 'Подарок уже обменян в другой сделке');
    return o;
  };
  A.declineOffer = (db, ctx, { id }) => {
    const o = db.offers[id];
    if (!o || o.toId !== ctx.uid || o.status !== 'pending') throw err('Заявка не найдена', 404);
    o.status = 'declined'; o.closedAt = now(); o.reason = 'Владелец отклонил заявку';
  };
  A.cancelOffer = (db, ctx, { id }) => {
    const o = db.offers[id];
    if (!o || o.fromId !== ctx.uid || o.status !== 'pending') throw err('Заявка не найдена', 404);
    o.status = 'cancelled'; o.closedAt = now();
  };

  // Вывод: комиссия 50 ⭐
  A.requestWithdrawal = (db, ctx, { giftId }) => {
    const g = db.gifts[giftId];
    if (!g || g.ownerId !== ctx.uid) throw err('Подарок не найден', 404);
    if (g.status !== 'available') throw err('Подарок уже выводится');
    if (lockedSet(db).has(g.id)) throw err('Сначала отмените исходящие заявки с этим подарком');
    const u = db.users[ctx.uid];
    cancelOffersWith(db, [g.id], null, 'Подарок выводится из обменника');
    g.status = 'withdrawing';
    const w = { id: nextId(db, 'w'), giftId: g.id, userId: ctx.uid, to: u && u.username ? '@' + u.username : null,
      fee: FEE_STARS, status: 'awaiting_payment', createdAt: now() };
    db.withdrawals[w.id] = w;
    return w;
  };
  A.cancelWithdrawal = (db, ctx, { id }) => {
    const w = db.withdrawals[id];
    if (!w || w.userId !== ctx.uid) throw err('Заявка не найдена', 404);
    if (w.status !== 'awaiting_payment') throw err('Оплаченную заявку отменить нельзя — напишите @' + RELAYER);
    w.status = 'cancelled'; w.closedAt = now();
    const g = db.gifts[w.giftId]; if (g && g.status === 'withdrawing') g.status = 'available';
  };
  // Вызывается сервером после successful_payment от Telegram (режим invoice)
  A.markWithdrawalPaid = (db, _ctx, { id, chargeId, amount }) => {
    const w = db.withdrawals[id];
    if (!w) throw err('Заявка не найдена', 404);
    if (w.status === 'paid' || w.status === 'sent') return w;
    if (amount != null && amount < w.fee) throw err('Неверная сумма');
    w.status = 'paid'; w.paidAt = now(); w.chargeId = chargeId || null;
    return w;
  };
  // Ручной режим: пользователь сообщает, что отправил 50 ⭐ на @GiftXchangeRelayer
  A.claimManualPayment = (db, ctx, { id }) => {
    const w = db.withdrawals[id];
    if (!w || w.userId !== ctx.uid) throw err('Заявка не найдена', 404);
    if (w.status !== 'awaiting_payment') throw err('Статус заявки уже изменён');
    w.status = 'payment_claimed'; w.claimedAt = now();
  };
  A.adminConfirmPayment = (db, ctx, { id }) => {
    needAdmin(ctx);
    const w = db.withdrawals[id];
    if (!w || !['payment_claimed', 'awaiting_payment'].includes(w.status)) throw err('Заявка не ожидает подтверждения оплаты');
    w.status = 'paid'; w.paidAt = now(); w.manual = true;
  };
  A.adminMarkSent = (db, ctx, { id }) => {
    needAdmin(ctx);
    const w = db.withdrawals[id];
    if (!w || w.status !== 'paid') throw err('Вывод ещё не оплачен');
    w.status = 'sent'; w.sentAt = now(); w.by = ctx.uid;
    const g = db.gifts[w.giftId]; if (g) { g.status = 'withdrawn'; g.history.push({ t: now(), e: 'withdraw', u: w.userId }); }
  };
  A.adminRejectWithdrawal = (db, ctx, { id, reason }) => {
    needAdmin(ctx);
    const w = db.withdrawals[id];
    if (!w || ['sent', 'rejected', 'cancelled'].includes(w.status)) throw err('Заявку нельзя отклонить');
    w.status = 'rejected'; w.reason = String(reason || '').slice(0, 200) || null; w.closedAt = now();
    const g = db.gifts[w.giftId]; if (g && g.status === 'withdrawing') g.status = 'available';
    return w; // сервер вернёт звёзды через refundStarPayment, если есть chargeId
  };

  function needAdmin(ctx) { if (!ctx.isAdmin) throw err('Доступно только администратору', 403); }

  /* ---------- Состояние для клиента ---------- */
  function view(db, ctx) {
    const uid = ctx.uid, locked = lockedSet(db);
    const active = Object.values(db.gifts).filter(g => g.status !== 'withdrawn');
    const gv = g => giftView(db, g, locked);
    const giftSnap = id => db.gifts[id] ? gv(db.gifts[id]) : null;
    const offers = Object.values(db.offers).filter(o => o.fromId === uid || o.toId === uid)
      .sort((a, b) => b.createdAt - a.createdAt).slice(0, 100)
      .map(o => ({ id: o.id, from: pubUser(db.users[o.fromId]), to: pubUser(db.users[o.toId]), give: o.give.map(giftSnap).filter(Boolean),
        get: o.get.map(giftSnap).filter(Boolean), comment: o.comment, status: o.status, reason: o.reason || null, auto: !!o.auto, createdAt: o.createdAt, closedAt: o.closedAt || null, incoming: o.toId === uid }));
    const wv = w => ({ ...w, gift: giftSnap(w.giftId), user: pubUser(db.users[w.userId]), chargeId: undefined });
    const dv = d => ({ id: d.id, link: d.link, slug: d.slug, name: d.name, number: d.number, image: d.image, status: d.status,
      reason: d.reason || null, createdAt: d.createdAt, user: pubUser(db.users[d.userId]), meta: ctx.isAdmin ? d.meta : undefined });
    const res = {
      me: pubUser(db.users[uid]), isAdmin: !!ctx.isAdmin, fee: FEE_STARS, relayer: RELAYER, bot: BOT,
      paymentMode: ctx.paymentMode || 'invoice',
      market: active.filter(g => g.status === 'available' && g.ownerId !== uid).sort((a, b) => b.addedAt - a.addedAt).map(gv),
      mine: active.filter(g => g.ownerId === uid).sort((a, b) => b.addedAt - a.addedAt).map(gv),
      offers,
      deposits: Object.values(db.deposits).filter(d => d.userId === uid).sort((a, b) => b.createdAt - a.createdAt).slice(0, 50).map(dv),
      withdrawals: Object.values(db.withdrawals).filter(w => w.userId === uid).sort((a, b) => b.createdAt - a.createdAt).slice(0, 50).map(wv),
      stats: { gifts: active.filter(g => g.status === 'available').length, users: Object.keys(db.users).length,
        swaps: Object.values(db.offers).filter(o => o.status === 'accepted').length }
    };
    if (ctx.isAdmin) {
      res.admin = {
        deposits: Object.values(db.deposits).filter(d => d.status === 'pending').sort((a, b) => a.createdAt - b.createdAt).map(dv),
        withdrawals: Object.values(db.withdrawals).filter(w => ['paid', 'payment_claimed'].includes(w.status)).sort((a, b) => a.createdAt - b.createdAt).map(wv),
        recent: Object.values(db.withdrawals).filter(w => ['sent', 'rejected'].includes(w.status)).sort((a, b) => (b.closedAt || b.sentAt) - (a.closedAt || a.sentAt)).slice(0, 10).map(wv)
      };
    }
    return res;
  }

  const Core = { FEE_STARS, RELAYER, BOT, newDb, parseLink, upsertUser, findUser, actions: A, view, err };
  if (typeof module !== 'undefined' && module.exports) module.exports = Core; else root.GXCore = Core;
})(typeof window !== 'undefined' ? window : globalThis);
