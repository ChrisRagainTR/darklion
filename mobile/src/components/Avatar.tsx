import { useState } from 'react';
import { Image, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import { colors } from '../theme/tokens';

type Props = {
  name?: string | null;
  url?: string | null;
  size?: number;
  style?: StyleProp<ViewStyle>;
};

function initials(name?: string | null) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  return parts.slice(0, 2).map((part) => part[0]).join('').toUpperCase();
}

export function Avatar({ name, url, size = 44, style }: Props) {
  const [failed, setFailed] = useState(false);
  const dimension = { width: size, height: size, borderRadius: Math.round(size * 0.38) };
  const fontSize = Math.max(12, Math.round(size * 0.34));

  if (url && !failed) {
    return (
      <View style={[styles.avatar, dimension, style]}>
        <Image source={{ uri: url }} onError={() => setFailed(true)} style={[styles.image, dimension]} />
      </View>
    );
  }

  return (
    <View style={[styles.avatar, dimension, style]}>
      <Text style={[styles.text, { fontSize }]}>{initials(name)}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  avatar: {
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
    backgroundColor: 'rgba(201,168,76,0.16)',
    borderWidth: 1,
    borderColor: 'rgba(201,168,76,0.28)',
  },
  image: {
    resizeMode: 'cover',
  },
  text: {
    color: colors.gold2,
    fontWeight: '900',
  },
});
