import { useRef } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { WebView } from 'react-native-webview';
import { colors } from '../theme/tokens';

type Props = { onChange: (pngDataUrl: string | null) => void };

// A drawing surface rendered with a canvas, so the signature is saved as the same PNG the web portal sends.
const PAGE = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
<style>html,body{margin:0;height:100%;background:#f7f5ef;overflow:hidden;touch-action:none}canvas{display:block;width:100%;height:100%}
.line{position:fixed;left:18px;right:18px;bottom:34px;height:1px;background:rgba(15,17,23,.25)}</style></head>
<body><canvas id="c"></canvas><div class="line"></div><script>
var c=document.getElementById('c'),x=c.getContext('2d'),d=false,drawn=false,r=Math.min(window.devicePixelRatio||2,2);
function size(){c.width=c.clientWidth*r;c.height=c.clientHeight*r;x.scale(r,r);x.strokeStyle='#1b2233';x.lineWidth=2.6;x.lineCap='round';x.lineJoin='round';}
size();
function p(e){var t=e.touches?e.touches[0]:e,b=c.getBoundingClientRect();return{x:t.clientX-b.left,y:t.clientY-b.top};}
function send(){window.ReactNativeWebView.postMessage(drawn?c.toDataURL('image/png'):'');}
c.addEventListener('touchstart',function(e){e.preventDefault();d=true;var q=p(e);x.beginPath();x.moveTo(q.x,q.y);},{passive:false});
c.addEventListener('touchmove',function(e){e.preventDefault();if(!d)return;var q=p(e);x.lineTo(q.x,q.y);x.stroke();drawn=true;},{passive:false});
c.addEventListener('touchend',function(){d=false;send();});
window.clearPad=function(){x.clearRect(0,0,c.width,c.height);drawn=false;send();};
</script></body></html>`;

export function SignaturePad({ onChange }: Props) {
  const web = useRef<WebView>(null);
  return (
    <View style={styles.wrap}>
      <WebView
        ref={web}
        source={{ html: PAGE }}
        originWhitelist={['*']}
        scrollEnabled={false}
        bounces={false}
        style={styles.web}
        onMessage={e => onChange(e.nativeEvent.data || null)}
      />
      <Pressable onPress={() => web.current?.injectJavaScript('window.clearPad();true;')} style={styles.clear} accessibilityRole="button">
        <Text style={styles.clearText}>Clear</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { height: 180, borderRadius: 12, borderWidth: 1, borderColor: 'rgba(255,255,255,0.16)', overflow: 'hidden', backgroundColor: '#f7f5ef' },
  web: { flex: 1, backgroundColor: '#f7f5ef' },
  clear: { position: 'absolute', right: 10, bottom: 4, height: 32, justifyContent: 'center', paddingHorizontal: 8 },
  clearText: { color: '#6f5a1f', fontWeight: '600', fontSize: 14 },
});
