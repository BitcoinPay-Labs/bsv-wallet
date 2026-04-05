import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.bitcoinpay.bsvwallet',
  appName: 'BSV Wallet',
  webDir: 'dist',
  ios: {
    contentInset: 'automatic',
    preferredContentMode: 'mobile',
    scheme: 'BSV Wallet'
  },
  server: {
    iosScheme: 'capacitor'
  }
};

export default config;
