import type { Config } from "tailwindcss";

const config: Config = {
    darkMode: ["class"],
    content: [
    "./pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
    "*.{js,ts,jsx,tsx,mdx}"
  ],
  theme: {
  	extend: {
  		fontFamily: {
  			sans: [
  				'-apple-system',
  				'BlinkMacSystemFont',
  				'"SF Pro Text"',
  				'"SF Pro Display"',
  				'"PingFang SC"',
  				'system-ui',
  				'sans-serif'
  			],
  			display: [
  				'"SF Pro Display"',
  				'-apple-system',
  				'BlinkMacSystemFont',
  				'"PingFang SC"',
  				'sans-serif'
  			],
  			mono: ['"SF Mono"', 'SFMono-Regular', 'Menlo', 'Monaco', 'Consolas', 'monospace']
  		},
  		letterSpacing: {
  			tighter: '-0.04em',
  			tight: '-0.02em',
  			normal: '0',
  			wide: '0.02em'
  		},
  		colors: {
  			apple: {
  				blue: '#007AFF',
  				green: '#34C759',
  				indigo: '#5856D6',
  				orange: '#FF9500',
  				pink: '#FF2D55',
  				purple: '#AF52DE',
  				red: '#FF3B30',
  				teal: '#5AC8FA',
  				yellow: '#FFCC00'
  			},
  			surface: {
  				canvas: 'hsl(var(--surface-canvas) / <alpha-value>)',
  				card: 'hsl(var(--surface-card) / <alpha-value>)',
  				secondary: 'hsl(var(--surface-secondary) / <alpha-value>)'
  			},
  			label: {
  				primary: 'hsl(var(--label-primary) / <alpha-value>)',
  				secondary: 'hsl(var(--label-secondary) / <alpha-value>)',
  				tertiary: 'hsl(var(--label-tertiary) / <alpha-value>)',
  				quaternary: 'hsl(var(--label-quaternary) / <alpha-value>)'
  			},
  			separator: 'hsl(var(--separator) / <alpha-value>)',
  			background: 'hsl(var(--background))',
  			foreground: 'hsl(var(--foreground))',
  			card: {
  				DEFAULT: 'hsl(var(--card))',
  				foreground: 'hsl(var(--card-foreground))'
  			},
  			popover: {
  				DEFAULT: 'hsl(var(--popover))',
  				foreground: 'hsl(var(--popover-foreground))'
  			},
  			primary: {
  				DEFAULT: 'hsl(var(--primary))',
  				foreground: 'hsl(var(--primary-foreground))'
  			},
  			secondary: {
  				DEFAULT: 'hsl(var(--secondary))',
  				foreground: 'hsl(var(--secondary-foreground))'
  			},
  			muted: {
  				DEFAULT: 'hsl(var(--muted))',
  				foreground: 'hsl(var(--muted-foreground))'
  			},
  			accent: {
  				DEFAULT: 'hsl(var(--accent))',
  				foreground: 'hsl(var(--accent-foreground))'
  			},
  			destructive: {
  				DEFAULT: 'hsl(var(--destructive))',
  				foreground: 'hsl(var(--destructive-foreground))'
  			},
  			border: 'hsl(var(--border))',
  			input: 'hsl(var(--input))',
  			ring: 'hsl(var(--ring))',
  			chart: {
  				'1': 'hsl(var(--chart-1))',
  				'2': 'hsl(var(--chart-2))',
  				'3': 'hsl(var(--chart-3))',
  				'4': 'hsl(var(--chart-4))',
  				'5': 'hsl(var(--chart-5))'
  			},
  			sidebar: {
  				DEFAULT: 'hsl(var(--sidebar-background))',
  				foreground: 'hsl(var(--sidebar-foreground))',
  				primary: 'hsl(var(--sidebar-primary))',
  				'primary-foreground': 'hsl(var(--sidebar-primary-foreground))',
  				accent: 'hsl(var(--sidebar-accent))',
  				'accent-foreground': 'hsl(var(--sidebar-accent-foreground))',
  				border: 'hsl(var(--sidebar-border))',
  				ring: 'hsl(var(--sidebar-ring))'
  			}
  		},
  		borderRadius: {
  			'3xl': '1.25rem',
  			'2xl': '1rem',
  			xl: '0.75rem',
  			lg: 'var(--radius)',
  			md: 'calc(var(--radius) - 2px)',
  			sm: 'calc(var(--radius) - 4px)'
  		},
  		transitionTimingFunction: {
  			'apple-spring': 'cubic-bezier(0.175, 0.885, 0.32, 1.1)',
  			'apple-ease': 'cubic-bezier(0.25, 1, 0.5, 1)',
  			'apple-smooth': 'cubic-bezier(0.32, 0.72, 0, 1)'
  		},
  		keyframes: {
  			'accordion-down': {
  				from: {
  					height: '0'
  				},
  				to: {
  					height: 'var(--radix-accordion-content-height)'
  				}
  			},
  			'accordion-up': {
  				from: {
  					height: 'var(--radix-accordion-content-height)'
  				},
  				to: {
  					height: '0'
  				}
  			}
  		},
  		animation: {
  			'accordion-down': 'accordion-down 0.2s ease-out',
  			'accordion-up': 'accordion-up 0.2s ease-out'
  		}
  	}
  },
  plugins: [require("tailwindcss-animate")],
};
export default config;
