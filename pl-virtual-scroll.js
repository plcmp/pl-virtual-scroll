import { html, PlElement, TemplateInstance } from "polylib";
import { PlaceHolder } from "@plcmp/utils";
import {ContextMixin} from "polylib/engine/v1/ctx.js";
import {normalizePath} from "polylib/common.js";

/** @typedef VirtualScrollItem
 * @property {LightDataContext} ctx
 * @property {TemplateInstance} ti
 * @property {Number} index
 * @property {Number} h - height of rendered item
*/

class PlVirtualScroll extends PlElement {
    /** @type VirtualScrollItem[]*/
    phyPool = [];
    constructor() {
        super({ lightDom: true });
    }
    static properties = {
        as: { value: 'item' },
        items: { type: Array, observer: '_dataChanged' },
        renderedStart: { type: Number, value: 0 },
        renderedCount: { type: Number, value: 0 },
        phyItems: { type: Array, value: () => [] },
        canvas: { type: Object },
    }
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
        this.canvas.parentNode.addEventListener('scroll', e => this.onScroll(e) );
        let tplEl = [...this.childNodes].find( n => n.nodeType === document.COMMENT_NODE && n.textContent.startsWith('tpl:'));
        this.sTpl = tplEl?._tpl;
        this._hctx = tplEl?._hctx;

       /* let ti = new TemplateInstance(PlVirtualScroll.repTpl);
        ti.attach(canvas, this, this);
*/
        /* render items if them already assigned */
        /*if (Array.isArray(this.items) && this.items.length > 0) {
            this.render();
        }*/
    }
    _dataChanged(data, old, mutation) {
        // set microtask, element may be not inserted in dom tree yet,
        // but we need to know viewport height to render
        let [, index, ...rest] = normalizePath(mutation.path);
        switch (mutation.action) {
            case 'upd':
                if(mutation.path == 'items' && Array.isArray(mutation.value) && Array.isArray(mutation.oldValue)) {
                    this.phyPool.forEach(i => {
                        if (i.index !== null && i.index < this.items.length) {
                            if (this.items[i.index] instanceof PlaceHolder) this.items.load?.(this.items[i.index]);

                            i.ctx.replace(this.items[i.index]);
                            i.ctx.applyEffects();
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
                        if (this.items[el.index] instanceof PlaceHolder) this.items.load?.(this.items[el.index])
                    }
                } else {
                    setTimeout(() => this.render(), 0);
                }
                break;
            case 'splice':
                let { index: spliceIndex } = mutation;
                // if mutation is not root try to apply effects to childs (need when pushing to arrya inside array)
                if(rest.length > 0) {
                    let path = [this.as, ...rest].join('.');
                    this.phyPool[index].ctx.applyEffects({ ...mutation, path });
                } else {
                    this.phyPool.forEach(i => {
                        if (i.index !== null && i.index >= spliceIndex && i.index < this.items.length) {
                            if (this.items[i.index] instanceof PlaceHolder) this.items.load?.(this.items[i.index]);
                            
                            i.ctx.replace(this.items[i.index]);
                            i.ctx.applyEffects();
                            i.ctx._ti.applyBinds();
                        } else if (i.index >= this.items.length) {
                            i.index = null;
                        }
                    });
                }

                //TODO: add more Heuristic to scroll list if visible elements that not changed? like insert rows before
                //      visible area

                //refresh all PHY if they can be affected
                
                setTimeout(() => this.render(), 0);

                break;
        }
    }

    /**
     *
     * @param {Boolean} [scroll] - render for new scroll position
     */
    render(scroll) {
        let canvas = this.canvas;
        let offset = canvas.parentNode.scrollTop;
        let height = canvas.parentNode.offsetHeight;
        if (height === 0 || !this.items) return;

        if (!this.elementHeight && this.items.length > 0) {
            let el = this.renderItem(0, undefined, 0);
            this.elementHeight = el.h;
        }
        /*let first = Math.floor(offset / this.elementHeight);
        let last = Math.ceil((offset+height) / this.elementHeight);*/
        // Reset scroll position if update data smaller than current visible index
        if (!scroll && this.items.length < (offset + height * 1.5) / this.elementHeight) {
            canvas.parentNode.scrollTop = 0;
        }
        let shadowEnd = Math.min(this.items.length, Math.ceil((offset + height * 1.5) / this.elementHeight));
        let shadowBegin = Math.max(0, Math.floor(Math.min((offset - height / 2) / this.elementHeight, shadowEnd - height * 2 / this.elementHeight)));

        let used = [], unused = [];
        this.phyPool.forEach(x => {
            if (x.index !== null && shadowBegin <= x.index && x.index <= shadowEnd && x.index < this.items.length) {
                used.push(x);
            } else {
                unused.push(x);
            }
        });

        if (used.length > 0) {
            used = used.sort((a, b) => a.index - b.index);
            if (used[used.length - 1].index < shadowEnd) {
                let prev = used[used.length - 1];
                let lastUsedIndex = prev.index;
                for (let i = lastUsedIndex + 1; i <= Math.min(shadowEnd, this.items.length - 1); i++) {
                    prev = this.renderItem(i, unused.pop(), prev);
                }
            }
            if (used[0].index > shadowBegin) {
                let prev = used[0];
                let lastUsedIndex = prev.index;
                for (let i = lastUsedIndex - 1; i >= shadowBegin; i--) {
                    prev = this.renderItem(i, unused.pop(), prev, true);
                }
            }
        } else if (shadowBegin >= 0 && this.items.length > 0) {
            let prev = this.renderItem(shadowBegin, unused.pop(), shadowBegin * this.elementHeight);
            for (let i = shadowBegin + 1; i <= shadowEnd; i++) {
                prev = this.renderItem(i, unused.pop(), prev);
            }
        }

        unused.forEach(u => {
            u.index = null;
            u.ctx._ti._nodes.forEach(i => { if (i.style) i.style.transform = `translateY(-1000px)`; });
        });

        // fill .5 height window in background
        // while phy window not filed, expect +-.5 screen
        // render must begin from visible start forward, then backward to .5 s/h


        if (this.elementHeight && this.items.length)
            canvas.style.setProperty('height', this.elementHeight * this.items.length + 'px')
        else
            canvas.style.setProperty('height', 0)
    }

    /**
     *
     * @param index
     * @param {VirtualScrollItem} p_item
     * @param prev
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
        if (this.items[index] instanceof PlaceHolder) this.items.load?.(this.items[index])
        let target = p_item ?? this.createNewItem(this.items[index]);

        target.index = index;
        if (p_item) {
            p_item.ctx.replace(this.items[index])
            p_item.ctx._ti.applyBinds();
            p_item.ctx.applyEffects();
        } else {
            this.phyPool.push(target);
        }
        target.offset = typeof (prev) == 'number' ? prev : (backward ? prev.offset - target.h : prev.offset + prev.h);
        target.ctx._ti._nodes.forEach(n => {
            if (n.style) {
                n.style.transform = `translateY(${target.offset}px)`;
                n.style.position = 'absolute';
                n.setAttribute('virtualOffser', target.offset);
            }
        });
        return target;
    }
    createNewItem(v) {
        if (!this.sTpl) return;
        let inst = new TemplateInstance(this.sTpl);

        let ctx = new RepeatItem(v, this.as, (ctx, m) => this.onItemChanged(ctx, m) );
        ctx._ti = inst
        inst.attach(this.canvas, undefined, [ctx, ...this._hctx ]);
        let h = this.elementHeight ??  calcNodesRect(inst._nodes).height;

        return { ctx, h };
    }
    onScroll() {
        this.render(true);
    }
    onItemChanged(ctx, m) {
        // skip replace data call
        if (!m) return;
        let ind = this.items.findIndex( i => i === ctx[this.as]);
        if (ind < 0) console.warn('repeat item not found');
        if (m.path === this.as) {
            this.set(['items', ind], m.value, m.wmh);
        } else {
            this.forwardNotify(m,this.as, 'items.'+ind);
        }

    }
}

class RepeatItem extends ContextMixin(EventTarget) {
    constructor(item, as, cb) {
        super();
        this.as = as;
        this[as] = item;
        this.addEffect(as, m => cb(this, m))
    }
    get model() {
        return this[this.as];
    }
    replace(v) {
        this[this.as] = v;
        this.wmh = {};
    }
}

function calcNodesRect(nodes) {
    nodes = nodes.filter(n => n.getBoundingClientRect);
    let rect = nodes[0].getBoundingClientRect();
    let { top, bottom, left, right } = rect;
    ({ top, bottom, left, right } = nodes.map(n => n.getBoundingClientRect()).filter(i => i).reduce((a, c) => (
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