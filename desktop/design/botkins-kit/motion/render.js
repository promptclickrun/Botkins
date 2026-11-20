// Input is an original SVG from avatars/. Browser scripts load customize, catalog, then render.
const BotkinsMotion = (() => {
  const common = typeof module !== 'undefined' && module.exports;
  const kit = common ? require('../customize.js') : Botkins;
  const catalog = common ? require('./catalog.js') : BotkinsMotionCatalog;
  function render(source, stateName, options = {}) {
    const state = catalog.states[stateName];
    if (!state) throw Error('Unknown Botkins state: '+stateName);
    const styled = kit.render(source, options.eyes || state.eyes, options.palette || 'Original', options);
    const mouth = {smile:'m-6 0q6 7 12 0',laugh:'m-8 0q8 4 16 0-1 14-9 12-6-1-7-12z',sad:'m-6 3q6-8 12 0'}[state.mouth];
    let head = styled.slice(styled.indexOf('</title>')+8,styled.lastIndexOf('</svg>'));
    if(mouth) head=head.replace(/(<g data-layer="eyes" data-anchors="([\d.,]+)" fill="(#[\da-f]+)">)/i,(all,tag,coords,ink)=>{
      const [a,b,y]=coords.split(',').map(Number);
      return tag+'<path transform="translate('+((a+b)/2)+' '+(y+17)+')" d="'+mouth+'" fill="'+(state.mouth==='laugh'?ink:'none')+'" stroke="'+ink+'" stroke-width="3" stroke-linecap="round"/>';
    });
    const name = stateName.toLowerCase().replaceAll(' ','-');
    const poseName = 'bk-'+name;
    const pose = ([x,y,r])=>'translate('+x+'px,'+y+'px) rotate('+r+'deg)';
    const frames=state.poses.map((p,i)=>(100*i/(state.poses.length-1)).toFixed(2)+'%{transform:'+pose(p)+'}').join('');
    const timing=state.durationMs+'ms ease-in-out '+(state.loop?'infinite':'1 forwards');
    const motion=options.reducedMotion ? '' : '<style>@keyframes '+poseName+'{'+frames+'}.'+poseName+'{transform-origin:128px 172px;animation:'+poseName+' '+timing+'}@media(prefers-reduced-motion:reduce){.'+poseName+'{animation:none}}</style>';
    const icon=catalog.icons[state.badge];
    const badge=icon?'<g transform="translate(191 181)"><circle cx="22" cy="22" r="24" fill="#fff1d8" stroke="#644533" stroke-width="2"/><circle cx="22" cy="22" r="20" fill="'+catalog.colors[state.color]+'"/><path transform="translate(8 8) scale(.875)" d="'+icon+'" fill="'+(['heart','spark','drop'].includes(state.badge)?'#fff1d8':'none')+'" stroke="#392a22" stroke-width="'+(state.badge==='dots'?5:2.7)+'" stroke-linecap="round" stroke-linejoin="round"/></g>':'';
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" width="256" height="256"><title>'+styled.match(/<title>([^<]*)/)[1]+' · '+stateName+'</title>'+motion+'<g class="'+poseName+'">'+head+'</g>'+badge+'</svg>';
  }
  return {render,states:Object.keys(catalog.states)};
})();
if(typeof module!=='undefined') module.exports=BotkinsMotion;
