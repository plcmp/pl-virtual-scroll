import { html, PlElement, TemplateInstance } from 'polylib';
import { PlaceHolder } from '@plcmp/utils';
import { ContextMixin } from 'polylib/engine/v1/ctx.js';
import { normalizePath } from 'polylib/common.js';

/** @typedef VirtualScrollItem
 * @property { RepeatItem } ctx
 * @property { TemplateInstance } ti
 * @property { number | null } index
 * @property { number } h - height of rendered item
 * @property { number } offset
*/

class PlVirtualScroll extends PlElement {
    /** @type VirtualScrollItem[] */
    phyPool = [];
    /** @type {number | undefined} */
    elementHeight;

    constructor() {
        super({ lightDom: true });
    }

    static properties = {
        as: { value: 'item' },
        items: { type: Array, observer: '_dataChanged' },
        phyItems: { type: Array, value: () => [] },
        canvas: { type: Object },
        variableRowHeight: { type: Boolean, value: false },
        rowHeight: { type: Number }
    };

    static template = html`
        <style>
            pl-virtual-scroll {
                height: 100%;
                overflow: auto;
                display: block;
            }

            pl-virtual-scroll #vs-canvas {
                position: relative;
                /*noinspection CssUnresolvedCustomProperty*/
                contain: strict;
            }

            .vs-item {
                position: absolute;
                left: 0;
                top: 0;
                width: 100%;
            }
            #vsCanvas {
                position: relative;
            }
        </style>
        <div id="vsCanvas"></div>
    `;

    static repTpl = html`<template d:repeat="{{phyItems}}" d:as="[[as]]"><div class="vs-item">[[sTpl]]</div></template>`;

    connectedCallback() {
        super.connectedCallback();

        this.canvas = this.canvas ?? this.$.vsCanvas;
        this.canvas.parentNode.addEventListener('scroll', e => this.onScroll(e));
        let tplEl = [...this.childNodes].find(n => n.nodeType === document.COMMENT_NODE && n.textContent.startsWith('tpl:'));
        this.sTpl = tplEl?._tpl;
        this._hctx = tplEl?._hctx;
    }

    _dataChanged(data, old, /** DataMutation */ mutation) {
        // set microtask, element may be not inserted in dom tree yet,
        // but we need to know viewport height to render
        let [, index, ...rest] = normalizePath(mutation.path);
        switch (mutation.action) {
            case 'upd':
                if (mutation.path === 'items' && Array.isArray(mutation.value) && Array.isArray(mutation.oldValue)) {
                    this.phyPool.forEach((i) => {
                        if (i.index !== null && i.index < this.items.length) {
                            if (this.items[i.index] instanceof PlaceHolder) this.items.load?.(this.items[i.index]);

                            i.ctx.replace(this.items[i.index]);
                            i.ctx.applyEffects(undefined);
                            i.ctx._ti.applyBinds();
                        } else if (i.index >= this.items.length) {
                            i.index = null;
                        }
                    });
                }

                if (index !== undefined && +index >= 0) {
                    let el = this.phyPool.find(i => i.index === +index);
                    if (el && rest.length > 0) {
                        let path = [this.as, ...rest].join('.');
                        el.ctx.applyEffects({ ...mutation, path });
                        if (this.items[el.index] instanceof PlaceHolder) this.items.load?.(this.items[el.index]);
                    }
                } else {
                    setTimeout(() => this.render(), 0);
                }
                break;

            case 'splice': {
                let { index: spliceIndex } = mutation;
                // if mutation is not root try to apply effects to children (need when pushing to array inside array)
                if (rest.length > 0) {
                    let path = [this.as, ...rest].join('.');
                    this.phyPool[index].ctx.applyEffects({...mutation, path});
                } else {
                    this.phyPool.forEach((i) => {
                        if (i.index !== null && i.index >= spliceIndex && i.index < this.items.length) {
                            if (this.items[i.index] instanceof PlaceHolder) this.items.load?.(this.items[i.index]);

                            i.ctx.replace(this.items[i.index]);
                            i.ctx.applyEffects(undefined);
                            i.ctx._ti.applyBinds();
                        } else if (i.index >= this.items.length) {
                            i.index = null;
                            i.offset = -10000;
                            fixOffset(i);
                        }
                    });
                }

                // TODO: add more Heuristic to scroll list if visible elements that not changed? like insert rows before
                //      visible area

                // refresh all PHY if they can be affected
                setTimeout(() => this.render(), 0);

                break;
            }
        }
    }

    render() {
        const canvas = this.canvas;
        let visibleStart = canvas.parentNode.scrollTop,
            height = canvas.parentNode.offsetHeight,
            visibleEnd = visibleStart + height,
            // render cant complete on too small window, set minimal shadow window
            shadowSize = Math.max(height / 2, 500),
            shadowStart = visibleStart - shadowSize,
            shadowEnd = visibleEnd + shadowSize;

        // cancel render on invisible canvas or empty data
        if (height === 0 || !this.items || this.items.length === 0) {
            canvas.style.setProperty('height', 0);
            return;
        }

        let used = this.phyPool
            .filter((i) => {
                if (i.offset + i.h < shadowStart || i.offset > shadowEnd) {
                    i.index = null;
                }
                return i.index !== null;
            })
            .sort((a, b) => a.index - b.index);

        // check items height and offset
        if (this.variableRowHeight) {
            let firstVisible = used.findIndex(i => i.offset >= visibleStart && i.offset < visibleEnd);
            if (firstVisible >= 0) {
                // fix forward
                for (let i = firstVisible + 1; i < used.length && used[i].offset < shadowEnd; i++) {
                    const newHeight = calcNodesRect(used[i - 1].ctx._ti._nodes).height;
                    if (used[i - 1].h !== newHeight) used[i - 1].h = newHeight;
                    if (used[i - 1].offset + newHeight !== used[i].offset) {
                        used[i].offset = used[i - 1].offset + newHeight;
                        fixOffset(used[i]);
                    }
                }
                // fix last height
                const last = used[used.length - 1];
                last.h = calcNodesRect(last.ctx._ti._nodes).height;
                // fix backward
                for (let i = firstVisible - 1; i >= 0 && used[i].offset > shadowStart; i--) {
                    const newHeight = calcNodesRect(used[i].ctx._ti._nodes).height;
                    if (used[i].h !== newHeight) used[i].h = newHeight;
                    if (used[i].offset + newHeight !== used[i + 1].offset) {
                        used[i].offset = used[i + 1].offset - newHeight;
                        fixOffset(used[i]);
                    }
                }
                used = used
                    .filter((i) => {
                        if (i.offset + i.h < shadowStart || i.offset > shadowEnd) {
                            i.index = null;
                        }
                        return i.index !== null;
                    })
                    .sort((a, b) => a.index - b.index);
            }
        }
        // filter

        let unused = this.phyPool.filter(i => i.index === null);

        let firstShadow = used.find(i => i.offset + i.h > shadowStart && i.offset < shadowEnd);
        let lastShadow = used.findLast(i => i.offset < shadowEnd && i.offset + i.h > shadowStart);

        if (!firstShadow && !lastShadow) {
            // jump to nowhere,
            if (this.canvas.parentNode.scrollTop === 0)
                firstShadow = lastShadow = this.renderItem(0, unused.pop());
            else {
                const heightForStart
                    = this.phyPool.length > 0
                        ? this.phyPool.reduce((a, i) => a + i.h, 0) / this.phyPool.length
                        : 32; // TODO: replace w/o constant
                const predictedStart = Math.min(Math.ceil(this.canvas.parentNode.scrollTop / heightForStart), this.items.length - 1);
                firstShadow = lastShadow = this.renderItem(predictedStart, unused.pop(), this.canvas.parentNode.scrollTop);
            }

            used.unshift(firstShadow);
        }

        // render forward
        while (
            lastShadow.offset + lastShadow.h < shadowEnd // последний нарисованный не дотягивает до конца окна рисования
            && lastShadow.index < this.items.length - 1 // при этом данные еще не кончились
        ) {
            lastShadow = this.renderItem(lastShadow ? lastShadow.index + 1 : 0, unused.pop(), lastShadow);
            used.push(lastShadow);
        }

        // render backward
        while (
            firstShadow.offset > shadowStart // последний нарисованный не дотягивает до конца окна рисования
            && firstShadow.index > 0 // при этом данные еще не кончились
        ) {
            firstShadow = this.renderItem(firstShadow.index - 1, unused.pop(), firstShadow, true);
            used.unshift(firstShadow);
        }

        // move unused to invisible place
        unused.forEach((i) => {
            i.offset = -10000;
            fixOffset(i);
        });

        // calc offset and canvas size
        // TODO: reduce scroll jump
        const avgHeight = used.reduce((a, i) => a + i.h, 0) / used.length;

        if (lastShadow && !isNaN(avgHeight) && isFinite(avgHeight)) {
            const
                lastRenderedPixel = lastShadow.offset + lastShadow.h,
                restRows = this.items.length - lastShadow.index - 1,
                currentHeight = canvas.offsetHeight,
                predictedHeight = lastRenderedPixel + restRows * avgHeight;

            if (Math.abs(predictedHeight - currentHeight) > restRows / 10 * avgHeight) {
                canvas.style.setProperty('height', predictedHeight + 'px');
                if (predictedHeight - currentHeight > avgHeight) {
                    setTimeout(() => this.render(), 0);
                }
            }
        }

        if (firstShadow && !isNaN(avgHeight) && isFinite(avgHeight)) {
            const
                firstRenderedPixel = firstShadow.offset,
                restRows = firstShadow.index,
                predictedOffset = firstRenderedPixel - restRows * avgHeight;

            if (Math.abs(predictedOffset) > restRows / 10 * avgHeight) {
                used.forEach((i) => {
                    i.offset -= predictedOffset;
                    fixOffset(i);
                });
                this.canvas.parentNode.scrollTop -= predictedOffset;
            }
        }
    }

    /**
     *
     * @param index
     * @param {VirtualScrollItem} p_item
     * @param [prev]
     * @param [backward]
     * @return {VirtualScrollItem}
     */
    renderItem(index, p_item, prev, backward) {
        // get from pull of phy
        // on need more create one
        if (index < 0 || index >= this.items.length) {
            if (p_item) p_item.index = null;
            return p_item;
        }
        if (this.items[index] instanceof PlaceHolder) this.items.load?.(this.items[index]);
        let target = p_item ?? this.createNewItem(this.items[index]);

        target.index = index;
        if (p_item) {
            p_item.ctx.replace(this.items[index]);
            p_item.ctx._ti.applyBinds();
            p_item.ctx.applyEffects(undefined);
            if (!this.variableRowHeight) p_item.h = calcNodesRect(p_item.ctx._ti._nodes).height;
        } else {
            this.phyPool.push(target);
        }
        prev ??= 0;
        target.offset = typeof (prev) == 'number' ? prev : (backward ? prev.offset - target.h : prev.offset + prev.h);
        target.ctx._ti._nodes.forEach((n) => {
            if (n.style) {
                n.style.transform = `translateY(${target.offset}px)`;
                n.style.position = 'absolute';
            }
        });
        return target;
    }

    createNewItem(v) {
        if (!this.sTpl) return;
        let inst = new TemplateInstance(this.sTpl);

        let ctx = new RepeatItem(v, this.as, (ctx, m) => this.onItemChanged(ctx, m));
        ctx._ti = inst;
        inst.attach(this.canvas, undefined, [ctx, ...this._hctx]);
        let h = !this.variableRowHeight && this.elementHeight ? this.elementHeight : calcNodesRect(inst._nodes).height;

        if (!this.variableRowHeight && !this.elementHeight) {
            this.elementHeight = h;
        }

        return { ctx, h };
    }

    onScroll() {
        this.render(true);
    }

    onItemChanged(ctx, m) {
        // skip replace data call
        if (!m) return;
        let ind = this.items.findIndex(i => i === ctx[this.as]);
        if (ind < 0) console.warn('repeat item not found');
        if (m.path === this.as) {
            this.set(['items', ind], m.value, m.wmh);
        } else {
            this.forwardNotify(m, this.as, 'items.' + ind);
        }
    }
}

class RepeatItem extends ContextMixin(EventTarget) {
    constructor(item, as, cb) {
        super();
        this.as = as;
        this[as] = item;
        this.addEffect(as, m => cb(this, m));
    }

    get model() {
        return this[this.as];
    }

    replace(v) {
        this[this.as] = v;
        this.wmh = {};
    }
}

function fixOffset(item) {
    item.ctx._ti._nodes.forEach((n) => {
        if (n.style) {
            n.style.transform = `translateY(${item.offset}px)`;
        }
    });
}

function calcNodesRect(nodes) {
    nodes = nodes.filter(n => n.getBoundingClientRect);
    let rect = nodes[0].getBoundingClientRect();
    let { top, bottom, left, right } = rect;
    ({ top, bottom, left, right } = nodes.map(n => n.getBoundingClientRect())
        .filter(i => i)
        .reduce((a, c) => (
            {
                top: Math.min(a.top, c.top),
                bottom: Math.max(a.bottom, c.bottom),
                left: Math.min(a.left, c.left),
                right: Math.max(a.right, c.right)
            })
        , { top, bottom, left, right }));
    let { x, y, height, width } = { x: left, y: top, width: right - left, height: bottom - top };
    return { x, y, height, width };
}

customElements.define('pl-virtual-scroll', PlVirtualScroll);
