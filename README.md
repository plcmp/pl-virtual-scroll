# @plcmp/pl-virtual-scroll

Component for lazy list render.

## Components

- `pl-virtual-scroll` — virtualized list
- `pl-virtual-scroll-dnd` — drag-and-drop reorder; array taken from `target` (`data` / `items`)

```html
<pl-table id="table" data="{{items}}"></pl-table>
<pl-virtual-scroll-dnd target="[[$.table]]" on-reorder="[[onReorder]]"></pl-virtual-scroll-dnd>
```

```js
import '@plcmp/pl-virtual-scroll/pl-virtual-scroll-dnd.js';
```
