import { PlElement, css } from 'polylib';

const DRAG_THRESHOLD = 6;
/** Edge zone as a fraction of viewport height (dnd-kit-like ~0.2) */
const AUTO_SCROLL_THRESHOLD = 0.2;
const AUTO_SCROLL_EDGE_MIN = 40;
const AUTO_SCROLL_MAX = 18;

/**
 * Reorder DnD for a host that owns a pl-virtual-scroll.
 * List comes from target (`data` | `items`); row indices from phyPool.
 *
 * Drop geometry:
 * - `insertAt` — slot index in the current list (before removing the dragged block)
 * - `to` — index after removing the block (`#dropIndex`); used for splice
 *
 * @property {string} [handleIcon] — ignore other `pl-icon`s (keep only this icon)
 * @property {string} [blockField] — block size field (e.g. `_childrenCount` → 1+n)
 * @property {boolean} [lockY=true] — horizontal move before threshold cancels arm;
 *   `false` — distance threshold, `deltaX` exposed on `reorder` (mixed nesting)
 */
class PlVirtualScrollDnd extends PlElement {
    static properties = {
        target: { type: Object, observer: '_targetChanged' },
        disabled: { type: Boolean, value: false },
        handleIcon: { type: String },
        blockField: { type: String },
        lockY: { type: Boolean, value: true }
    };

    static dragCss = css`
        .pl-vs-dnd-drag {
            z-index: 10;
            cursor: grabbing;
            box-shadow: -10px 4px 20px 0 rgba(42, 49, 67, 0.15);
        }

        .pl-vs-dnd-no-select,
        .pl-vs-dnd-no-select * {
            user-select: none !important;
        }
    `;

    #virtualScroll;
    #host;
    #scrollEl;
    #mutationObserver;
    #drag;
    #autoScrollFrame;
    /** Cached `#visible()` for the current pointer/scroll tick */
    #visibleCache;

    #onPointerDown = event => !this.disabled && this.#arm(event);

    #onPointerMove = event => this.#move(event);

    #onPointerUp = event => this.#up(event);

    #onScroll = () => {
        if (!this.#drag?.active) return;
        this.#invalidateVisible();
        this.#syncDrag(this.#drag.clientY);
    };

    #onKeyDown = (event) => {
        if (event.key === 'Escape' && this.#drag?.active) {
            event.preventDefault();
            this.#end();
        }
    };

    disconnectedCallback() {
        this.#detach();
        super.disconnectedCallback?.();
    }

    _targetChanged(target) {
        this.#detach();
        if (target) this.#attach(target);
    }

    #listPath() {
        return this.target?.localName === 'pl-virtual-scroll' ? 'items' : 'data';
    }

    #items() {
        const list = this.target?.[this.#listPath()];
        return Array.isArray(list) ? list : undefined;
    }

    #blockCount(model) {
        if (!this.blockField || !model) return 1;
        return 1 + (model[this.blockField] ?? 0);
    }

    /** `insertAt` → splice index after the dragged block is removed */
    #dropIndex(insertAt, from, count) {
        return insertAt > from ? insertAt - count : insertAt;
    }

    #findVirtualScroll(target) {
        if (!target) return;
        if (target.localName === 'pl-virtual-scroll') return target;
        return target.shadowRoot?.querySelector('pl-virtual-scroll')
          ?? target.querySelector?.('pl-virtual-scroll');
    }

    #attach(target) {
        const virtualScroll = this.#findVirtualScroll(target);
        if (!virtualScroll) {
            const root = target.shadowRoot ?? target;
            this.#mutationObserver = new MutationObserver(() => {
                if (this.target === target && this.#findVirtualScroll(target)) {
                    this.#mutationObserver.disconnect();
                    this.#mutationObserver = undefined;
                    this.#attach(target);
                }
            });
            this.#mutationObserver.observe(root, { childList: true, subtree: true });
            return;
        }

        this.#virtualScroll = virtualScroll;

        const styleRoot = target.shadowRoot ?? target.getRootNode();
        if (!styleRoot.adoptedStyleSheets.includes(this.constructor.dragCss)) {
            styleRoot.adoptedStyleSheets = [...styleRoot.adoptedStyleSheets, this.constructor.dragCss];
        }

        this.#host = target;
        target.addEventListener('pointerdown', this.#onPointerDown);
        this.#scrollEl = virtualScroll.canvas?.parentNode
          ?? virtualScroll.$?.vsCanvas?.parentNode
          ?? virtualScroll;
        this.#scrollEl.addEventListener('scroll', this.#onScroll, { passive: true });
    }

    #detach() {
        this.#end();
        this.#mutationObserver?.disconnect();
        this.#mutationObserver = undefined;
        this.#host?.removeEventListener('pointerdown', this.#onPointerDown);
        this.#host = undefined;
        this.#scrollEl?.removeEventListener('scroll', this.#onScroll);
        this.#scrollEl = undefined;
        this.#virtualScroll = undefined;
        this.#invalidateVisible();
    }

    #invalidateVisible() {
        this.#visibleCache = undefined;
    }

    #visible() {
        if (this.#visibleCache) return this.#visibleCache;
        const items = this.#items();
        if (!items || !this.#virtualScroll?.phyPool) {
            this.#visibleCache = [];
            return this.#visibleCache;
        }
        this.#visibleCache = this.#virtualScroll.phyPool
            .filter(phy => typeof phy.index === 'number' && phy.ctx)
            .map((phy) => {
                const listIndex = phy.index;
                const model = items[listIndex];
                const nodes = phy.ctx._ti?._nodes;
                const rowEl = nodes?.find(node => node?.nodeType === Node.ELEMENT_NODE) ?? nodes?.[0];
                return model === undefined || !rowEl
                    ? undefined
                    : { model, rowEl, listIndex, phy, nodes };
            })
            .filter(Boolean)
            .sort((left, right) => left.listIndex - right.listIndex);
        return this.#visibleCache;
    }

    #arm(event) {
        if (event.button !== 0 || this.#drag || !this.#items()) return;
        this.#invalidateVisible();
        const composedPath = event.composedPath();
        // Same idea as form DnD: block other icons (edit/delete), allow row body + handle
        if (this.handleIcon && composedPath.some(node =>
            node.localName === 'pl-icon' && node.icon && node.icon !== this.handleIcon
        )) return;

        const hit = this.#visible().find(row => composedPath.some(node => row.nodes.includes(node)));
        if (!hit) return;

        const { rowEl, listIndex: from, model } = hit;
        this.#drag = {
            rowEl,
            from,
            model,
            count: this.#blockCount(model),
            insertAt: from,
            startX: event.clientX,
            startY: event.clientY,
            clientX: event.clientX,
            clientY: event.clientY,
            lastClientY: event.clientY,
            grabOffsetY: 0,
            gap: 0,
            pointerId: event.pointerId,
            baseTransform: rowEl.style.transform || '',
            intentUp: false,
            intentDown: false,
            scrollHitStart: false,
            scrollHitEnd: false,
            shifted: new Set(),
            active: false
        };
        // No capture until activate — keep text selection on horizontal intent
        this.#host.addEventListener('pointermove', this.#onPointerMove);
        this.#host.addEventListener('pointerup', this.#onPointerUp);
        this.#host.addEventListener('pointercancel', this.#onPointerUp);
        document.addEventListener('keydown', this.#onKeyDown);
    }

    #move(event) {
        const drag = this.#drag;
        if (!drag) return;
        drag.clientX = event.clientX;
        drag.clientY = event.clientY;

        if (!drag.active) {
            if (!this.#tryActivate(drag, event)) return;
        } else {
            this.#updateScrollIntent(drag, event.clientY);
        }

        event.preventDefault();
        this.#invalidateVisible();
        this.#syncDrag(event.clientY);
    }

    /** @returns {boolean} whether drag is active after this call */
    #tryActivate(drag, event) {
        const deltaX = event.clientX - drag.startX;
        const deltaY = event.clientY - drag.startY;
        const absX = Math.abs(deltaX);
        const absY = Math.abs(deltaY);

        if (this.lockY) {
            if (absX < DRAG_THRESHOLD && absY < DRAG_THRESHOLD) return false;
            if (absX > absY) {
                this.#end();
                return false;
            }
            if (absY < DRAG_THRESHOLD) return false;
        } else if (absX * absX + absY * absY < DRAG_THRESHOLD * DRAG_THRESHOLD) {
            return false;
        }

        this.#activate(drag);
        return true;
    }

    #updateScrollIntent(drag, clientY) {
        if (clientY < drag.lastClientY) drag.intentUp = true;
        if (clientY > drag.lastClientY) drag.intentDown = true;
        drag.lastClientY = clientY;
    }

    #activate(drag) {
        drag.active = true;
        const rect = drag.rowEl.getBoundingClientRect();
        // Recompute at activate so threshold travel does not shift the grab point
        drag.grabOffsetY = drag.clientY - rect.top;
        drag.gap = rect.height || this.#virtualScroll?.elementHeight || 0;
        drag.rowEl.classList.add('pl-vs-dnd-drag');
        drag.rowEl.setPointerCapture?.(drag.pointerId);
        this.#lockSelect();
        // Extra scroll room after the last row so insert-at-end has a visible slot
        this.#setEndDropSlot(drag.gap);
        drag.scrollHitEnd = false;
        this.#placeDragged();
        this.#startAutoScroll();
    }

    /**
     * Canvas paddingBottom = one row. Prefer padding over editing VS height math;
     * VS may rewrite canvas.height but padding still grows scrollHeight.
     */
    #setEndDropSlot(px) {
        const canvas = this.#virtualScroll?.canvas;
        if (!canvas) return;
        canvas.style.paddingBottom = px ? `${px}px` : '';
    }

    #syncDrag(clientY) {
        const drag = this.#drag;
        if (!drag?.active) return;
        this.#placeDragged();
        drag.insertAt = this.#insertAt(clientY, drag);
        this.#preview(drag.insertAt);
    }

    /** Row follows pointer: translateY from canvas top (scroll is in canvasTop) */
    #placeDragged() {
        const drag = this.#drag;
        const canvas = this.#virtualScroll?.canvas;
        if (!drag?.active || !canvas) return;
        const offset = drag.clientY - drag.grabOffsetY - canvas.getBoundingClientRect().top;
        drag.rowEl.style.transform = `translateY(${offset}px)`;
    }

    #lockSelect() {
        this.#scrollEl?.classList.add('pl-vs-dnd-no-select');
        window.getSelection?.()?.removeAllRanges?.();
    }

    #unlockSelect() {
        this.#scrollEl?.classList.remove('pl-vs-dnd-no-select');
    }

    #startAutoScroll() {
        if (this.#autoScrollFrame) return;
        const tick = () => {
            this.#autoScrollFrame = undefined;
            if (!this.#drag?.active || !this.#scrollEl) return;
            this.#autoScrollStep();
            this.#autoScrollFrame = requestAnimationFrame(tick);
        };
        this.#autoScrollFrame = requestAnimationFrame(tick);
    }

    #stopAutoScroll() {
        if (!this.#autoScrollFrame) return;
        cancelAnimationFrame(this.#autoScrollFrame);
        this.#autoScrollFrame = undefined;
    }

    /**
     * Max scrollTop from real content (+ end drop slot), not VS canvas.height
     * (VS often overestimates with avgHeight * restRows).
     */
    #contentMaxScroll() {
        const items = this.#items();
        const scrollEl = this.#scrollEl;
        const vs = this.#virtualScroll;
        const pool = vs?.phyPool;
        if (!items?.length || !scrollEl || !pool) return;

        const lastIndex = items.length - 1;
        const gap = this.#drag?.gap || vs.elementHeight || 0;
        const lastPhy = pool.find(item => item.index === lastIndex);
        if (lastPhy && typeof lastPhy.offset === 'number') {
            const end = lastPhy.offset + (lastPhy.h || gap) + gap;
            return Math.max(0, end - scrollEl.clientHeight);
        }

        const tail = pool
            .filter(item => typeof item.index === 'number')
            .sort((left, right) => right.index - left.index)[0];
        if (!tail || !gap) return;
        const end = tail.offset + (tail.h || gap) + (lastIndex - tail.index) * gap + gap;
        return Math.max(0, end - scrollEl.clientHeight);
    }

    #latchScrollHit(drag, delta) {
        if (delta < 0) drag.scrollHitStart = true;
        if (delta > 0) drag.scrollHitEnd = true;
    }

    #autoScrollStep() {
        const drag = this.#drag;
        const scrollEl = this.#scrollEl;
        if (!drag || !scrollEl) return;

        const box = scrollEl.getBoundingClientRect();
        const edge = Math.max(AUTO_SCROLL_EDGE_MIN, box.height * AUTO_SCROLL_THRESHOLD);
        const y = drag.clientY;
        const inTopEdge = y < box.top + edge;
        const inBottomEdge = y > box.bottom - edge;

        // Leaving the edge unlocks further scroll if more room appears
        if (!inTopEdge) drag.scrollHitStart = false;
        if (!inBottomEdge) drag.scrollHitEnd = false;

        let delta = 0;
        if (drag.intentUp && inTopEdge && !drag.scrollHitStart) {
            const depth = Math.min(edge, Math.max(0, box.top + edge - y)) / edge;
            delta = -Math.ceil(AUTO_SCROLL_MAX * depth * depth);
        } else if (drag.intentDown && inBottomEdge && !drag.scrollHitEnd) {
            const depth = Math.min(edge, Math.max(0, y - (box.bottom - edge))) / edge;
            delta = Math.ceil(AUTO_SCROLL_MAX * depth * depth);
        }
        if (!delta) return;

        let maxScroll = Math.max(0, scrollEl.scrollHeight - scrollEl.clientHeight);
        const contentMax = this.#contentMaxScroll();
        if (contentMax !== undefined) maxScroll = Math.min(maxScroll, contentMax);

        const prev = scrollEl.scrollTop;
        const next = Math.max(0, Math.min(maxScroll, prev + delta));
        const moved = Math.abs(next - prev) >= 0.5 && ((delta > 0 && next > prev) || (delta < 0 && next < prev));
        if (!moved) {
            this.#latchScrollHit(drag, delta);
            return;
        }

        scrollEl.scrollTop = next;
        if ((delta < 0 && scrollEl.scrollTop <= 0.5) || (delta > 0 && scrollEl.scrollTop >= maxScroll - 0.5)) {
            this.#latchScrollHit(drag, delta);
        }
    }

    #insertAt(clientY, drag) {
        const items = this.#items();
        const canvas = this.#virtualScroll?.canvas;
        if (!canvas) return drag.from;
        // Hit-test phy.offset (unshifted); using getBoundingClientRect after preview drifts insertAt
        const canvasTop = canvas.getBoundingClientRect().top;
        const { from, count, model } = drag;
        const blockEnd = from + count;
        const visibleRows = this.#visible().filter(row =>
            row.model !== model && (row.listIndex < from || row.listIndex >= blockEnd)
        );
        for (const row of visibleRows) {
            const height = row.phy.h || drag.gap || 0;
            const top = canvasTop + row.phy.offset;
            if (height > 0 && clientY < top + height / 2) return row.listIndex;
        }
        return visibleRows.length
            ? Math.min(visibleRows.at(-1).listIndex + 1, items.length)
            : from;
    }

    #preview(insertAt) {
        const drag = this.#drag;
        const { from, count, shifted, rowEl } = drag;
        const gap = (drag.gap || 0) * count;
        const blockEnd = from + count;
        const visible = this.#visible();
        const rowByIndex = new Map(visible.map(row => [row.listIndex, row]));
        const prevShifted = new Set(shifted);
        shifted.clear();

        // Only rows between pickup and insert; base is current VS phy.offset
        const shiftRow = (listIndex, delta) => {
            const row = rowByIndex.get(listIndex);
            if (!row || row.rowEl === rowEl) return;
            shifted.add(row.rowEl);
            row.rowEl.style.transition = 'transform 0.12s ease';
            row.rowEl.style.transform = `translateY(${row.phy.offset + delta}px)`;
        };

        if (insertAt > blockEnd) {
            for (let index = blockEnd; index < insertAt; index++) shiftRow(index, -gap);
        } else if (insertAt < from) {
            for (let index = insertAt; index < from; index++) shiftRow(index, gap);
        }

        for (const shiftEl of prevShifted) {
            if (shifted.has(shiftEl)) continue;
            shiftEl.style.transition = '';
            const row = visible.find(item => item.rowEl === shiftEl);
            if (row) shiftEl.style.transform = `translateY(${row.phy.offset}px)`;
        }
    }

    #restoreRowOffset(rowEl, fallbackTransform) {
        const row = this.#visible().find(item => item.rowEl === rowEl);
        if (row) {
            rowEl.style.transform = `translateY(${row.phy.offset}px)`;
            return;
        }
        if (fallbackTransform !== undefined) rowEl.style.transform = fallbackTransform;
    }

    #up(event) {
        const drag = this.#drag;
        if (!drag) return;
        if (!drag.active || event?.type === 'pointercancel' || this.#isOutsideDropZone(event)) {
            this.#end();
            return;
        }
        const { from, count, model, clientX, startX, insertAt } = drag;
        const to = this.#dropIndex(insertAt, from, count);
        const deltaX = clientX - startX;
        this.#end();
        if (!this.#items()) return;
        const moved = to !== from;
        if (moved) {
            const listPath = this.#listPath();
            const block = this.#items().slice(from, from + count);
            this.target.splice(listPath, from, count);
            this.target.splice(listPath, to, 0, ...block);
        }
        this.dispatchEvent(new CustomEvent('reorder', {
            bubbles: true,
            composed: true,
            detail: { from, to, insertAt, item: model, count, deltaX, moved }
        }));
    }

    /** Cancel drop if pointer is far outside the scrollport (pad = block height) */
    #isOutsideDropZone(event) {
        if (!event || event.clientY === undefined || event.clientY === null) return true;
        const box = this.#scrollEl?.getBoundingClientRect?.();
        if (!box) return true;
        const pad = (this.#drag?.gap || 0) * (this.#drag?.count || 1);
        return event.clientX < box.left || event.clientX > box.right
          || event.clientY < box.top - pad || event.clientY > box.bottom + pad;
    }

    #end() {
        const drag = this.#drag;
        if (!drag) return;
        this.#invalidateVisible();
        for (const shiftEl of drag.shifted) {
            shiftEl.style.transition = '';
            this.#restoreRowOffset(shiftEl);
        }
        drag.rowEl.style.transition = '';
        this.#restoreRowOffset(drag.rowEl, drag.baseTransform);
        drag.rowEl.classList.remove('pl-vs-dnd-drag');
        if (drag.rowEl.hasPointerCapture?.(drag.pointerId)) {
            drag.rowEl.releasePointerCapture(drag.pointerId);
        }
        this.#stopAutoScroll();
        this.#setEndDropSlot(0);
        this.#unlockSelect();
        this.#host?.removeEventListener('pointermove', this.#onPointerMove);
        this.#host?.removeEventListener('pointerup', this.#onPointerUp);
        this.#host?.removeEventListener('pointercancel', this.#onPointerUp);
        document.removeEventListener('keydown', this.#onKeyDown);
        this.#drag = undefined;
        this.#invalidateVisible();
    }
}

customElements.define('pl-virtual-scroll-dnd', PlVirtualScrollDnd);
