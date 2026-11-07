import { StyleSheet, Text, View } from 'react-native';
import { colors, fonts } from '../theme/tokens';
import type { TrackerStep } from '../types/api';

type Props = { steps: TrackerStep[] | null; note?: string; warn?: boolean };

// Compact progress line: numbered dots with labels underneath, current step in gold.
export function Tracker({ steps, note, warn }: Props) {
  if (!steps) return null;
  return (
    <View style={styles.wrap} accessibilityRole="progressbar" accessibilityLabel={steps.map(s => `${s.label} ${s.state}`).join(', ')}>
      <View style={styles.row}>
        {steps.map((step, i) => (
          <View key={step.label} style={styles.step}>
            <View style={styles.dotRow}>
              <View style={[styles.line, i === 0 && styles.hidden, step.state !== 'upcoming' && styles.lineDone]} />
              <View style={[styles.dot, step.state !== 'upcoming' && styles.dotOn, step.state === 'current' && styles.dotCurrent]}>
                <Text style={[styles.dotText, step.state !== 'upcoming' && styles.dotTextOn]}>{step.state === 'done' ? '✓' : i + 1}</Text>
              </View>
              <View style={[styles.line, i === steps.length - 1 && styles.hidden, steps[i + 1]?.state !== 'upcoming' && styles.lineDone]} />
            </View>
            <Text numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.8} style={[styles.label, step.state === 'current' && styles.labelCurrent, step.state === 'done' && styles.labelDone]}>{step.label}</Text>
          </View>
        ))}
      </View>
      {!!note && <Text style={[styles.note, warn && styles.noteWarn]}>{note}</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: 8 },
  row: { flexDirection: 'row' },
  step: { flex: 1, alignItems: 'center', gap: 6 },
  dotRow: { flexDirection: 'row', alignItems: 'center', alignSelf: 'stretch' },
  line: { flex: 1, height: 1, backgroundColor: 'rgba(255,255,255,0.18)' },
  lineDone: { backgroundColor: 'rgba(212,178,90,0.55)' },
  hidden: { opacity: 0 },
  dot: { width: 26, height: 26, borderRadius: 13, borderWidth: 1.5, borderColor: 'rgba(255,255,255,0.32)', alignItems: 'center', justifyContent: 'center' },
  dotOn: { backgroundColor: colors.goldBtn, borderColor: colors.goldBtn },
  dotCurrent: { shadowColor: colors.gold, shadowOpacity: 0.6, shadowRadius: 6, shadowOffset: { width: 0, height: 0 } },
  dotText: { color: colors.muted, fontSize: 12, fontWeight: '700' },
  dotTextOn: { color: '#15171d' },
  label: { color: colors.muted, fontSize: 12.5, fontFamily: fonts.sans },
  labelDone: { color: colors.text },
  labelCurrent: { color: colors.gold2, fontWeight: '700' },
  note: { color: colors.muted, fontSize: 13, textAlign: 'center' },
  noteWarn: { color: colors.amber },
});
