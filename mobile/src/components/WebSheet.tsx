import { ActivityIndicator, Linking, Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import Constants from 'expo-constants';
import { apiBaseUrl } from '../api/client';
import { WebView } from 'react-native-webview';
import { colors } from '../theme/tokens';

type Props = {
  url: string | null;
  title: string;
  onClose: () => void;
  // Signs a same-origin portal page in (for the organizer) by placing the session token before load.
  portalToken?: string;
  // Called for in-page navigations; return false to stop the WebView from following the link.
  onNavigate?: (url: string) => boolean;
};

export function WebSheet({ url, title, onClose, portalToken, onNavigate }: Props) {
  const trustedOrigin = new URL(apiBaseUrl()).origin;
  const isTrusted = (value: string) => { try { return new URL(value).origin === trustedOrigin; } catch { return false; } };
  const trusted = !!url && isTrusted(url);
  const inject = portalToken && trusted ? `try{if(location.origin===${JSON.stringify(trustedOrigin)})localStorage.setItem('portalToken', ${JSON.stringify(portalToken)});}catch(e){}true;` : undefined;
  return (
    <Modal visible={Boolean(url)} animationType="slide" presentationStyle="fullScreen" onRequestClose={onClose}>
      <View style={styles.root}>
        <View style={styles.bar}>
          <Pressable onPress={onClose} style={styles.btn} accessibilityRole="button"><Text style={styles.btnText}>Done</Text></Pressable>
          <Text numberOfLines={1} style={styles.title}>{title}</Text>
          {portalToken ? <View style={styles.btn} /> : <Pressable onPress={() => url && Linking.openURL(url)} style={styles.btn} accessibilityRole="button"><Text style={styles.btnText}>Open</Text></Pressable>}
        </View>
        {url ? (
          <WebView
            source={{ uri: url }}
            style={styles.web}
            startInLoadingState
            injectedJavaScriptBeforeContentLoaded={inject}
            onShouldStartLoadWithRequest={req => {
              if(portalToken && req.url !== 'about:blank' && !isTrusted(req.url)) return false;
              return onNavigate ? onNavigate(req.url) : true;
            }}
            renderLoading={() => <View style={styles.loading}><ActivityIndicator color={colors.gold2} /><Text style={styles.muted}>Loading…</Text></View>}
          />
        ) : null}
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg, paddingTop: Math.max(Constants.statusBarHeight, 20) },
  bar: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, height: 52, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: 'rgba(255,255,255,0.14)' },
  btn: { minWidth: 64, height: 44, justifyContent: 'center' },
  btnText: { color: colors.gold2, fontSize: 16, fontWeight: '600' },
  title: { flex: 1, textAlign: 'center', color: colors.text, fontSize: 16, fontWeight: '600' },
  web: { flex: 1, backgroundColor: '#fff' },
  loading: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center', gap: 10, backgroundColor: colors.bg },
  muted: { color: colors.muted },
});
