// Portable SVG string renderer. Pass the original standalone SVG on each change.
const Botkins = (() => {
  const palettes = {
    Original: null,
    Terracotta: ['#c75e35','#788449','#ffe5b7','#502e1e'],
    Honey: ['#dfa12e','#a65c39','#ffebc5','#553819'],
    Fern: ['#748848','#dfae52','#f4e8c4','#373722'],
    Tidepool: ['#518477','#dfad58','#f6e7c7','#303b30'],
    Bluebell: ['#738da4','#bf8061','#f8e5cf','#32303c'],
    Fig: ['#946079','#b99655','#f7e1cf','#482d39']
  };
  const eyeStyles = ['Oval','Button','Smile','Sleepy','Wink','Curious'];
  function rgb(hex) {
    return [1,3,5].map(i => parseInt(hex.slice(i,i+2),16));
  }
  function tint(original, target, role) {
    const [r,g,b] = rgb(original);
    const value = (Math.max(r,g,b)+Math.min(r,g,b))/510;
    const pivot = role === 'paper' ? 0.86 : 0.49;
    const amount = value < pivot ? value / pivot : (value-pivot)/(1-pivot);
    const result = rgb(target).map(c => Math.round(value < pivot ? c*amount : c+(255-c)*amount));
    return '#'+result.map(c=>c.toString(16).padStart(2,'0')).join('');
  }
  // Scale only open eyes around their own centers, independently of head motion.
  function blinkStyle(name) {
    const seed = [...name].reduce((hash,ch)=>(hash*31+ch.charCodeAt(0))>>>0,0);
    const period = 3800 + seed % 1201;
    const delay = -(seed % 2200);
    const cls = 'bk-blink-'+seed;
    const css = '<style data-layer="blink">@keyframes bk-blink{0%,92%,100%{transform:scaleY(1)}94%,94.6%{transform:scaleY(.09)}97%{transform:scaleY(1)}}.'+cls+'{transform-box:fill-box;transform-origin:center;animation:bk-blink '+period+'ms ease-in-out '+delay+'ms infinite}@media(prefers-reduced-motion:reduce){.'+cls+'{animation:none}}</style>';
    return {cls,css};
  }
  function render(source, eyes='Oval', palette='Original', options={}) {
    const colors = Array.isArray(palette) ? palette : palettes[palette];
    if (colors && (colors.length!==4 || colors.some(c=>!/^#[a-f\d]{6}$/i.test(c)))) throw Error('Expected four hex colors.');
    source = source.replace(/<style data-layer="blink">[\s\S]*?<\/style>/g,'');
    const blink = options.blink !== false && !options.reducedMotion && eyes !== 'Sleepy' && eyes !== 'Smile' ? blinkStyle(source.match(/<title>([^<]+)<\/title>/)[1]) : null;
    if (blink) source = source.replace('</title>','</title>'+blink.css);
    const art = colors ? source.replace(/<path data-role="(shell|accent|paper)"[^>]*>/g,(tag,role) => tag.replace(/#[a-f\d]{6}/gi,c=>tint(c,colors[['shell','accent','paper'].indexOf(role)],role))) : source;
    return art.replace(/<g data-layer="eyes" data-anchors="([^"]+)"[^>]*>[\s\S]*?<\/g>/,(match,anchors)=>{
      const [left,right,y]=anchors.split(',').map(Number);
      const ink=colors ? colors[3] : '#593515';
      const pair=[left,right].map((x,i)=>{
        if(eyes==='Smile' || eyes==='Sleepy' || (eyes==='Wink' && i===1)){
          const bend=eyes==='Sleepy'?7:-11;
          return '<path d="M'+(x-9)+' '+(y+3)+'q9 '+bend+' 18 0" stroke="'+ink+'" stroke-width="5.5" stroke-linecap="round" fill="none"/>';
        }
        const ry=eyes==='Button'?8.5:eyes==='Curious'&&i===1?12:17;
        return '<ellipse '+(blink?'class="'+blink.cls+'" ':'')+'cx="'+x+'" cy="'+(eyes==='Curious' && !i ? y-3:y)+'" rx="8.5" ry="'+ry+'"/>';
      }).join('');
      return '<g data-layer="eyes" data-anchors="'+anchors+'" fill="'+ink+'">'+pair+'</g>';
    });
  }
  return {render,palettes,eyeStyles};
})();
if (typeof module !== 'undefined') module.exports=Botkins;
