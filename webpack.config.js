/* eslint-disable */
const fs = require('fs');
const path = require('path');
const webpack = require('webpack');
const HtmlWebpackPlugin = require('html-webpack-plugin');
const CopyWebpackPlugin = require('copy-webpack-plugin');
const devCerts = require('office-addin-dev-certs');

module.exports = async (env, argv) => {
  const dev = argv.mode === 'development';
  // `--env http` serves plain HTTP (the standalone dashboard needs no add-in certs).
  const plainHttp = Boolean(env && env.http);

  const httpsOptions = dev && !plainHttp ? (await devCerts.getHttpsServerOptions()) : undefined;
  // Which of Crystal Ball's example workbooks this build ships (none in the public build).
  const cbExamples = path.resolve(__dirname, 'examples/crystal-ball');
  const cbExampleFiles = fs.existsSync(cbExamples) ? fs.readdirSync(cbExamples).filter((f) => /\.xls[xm]$/i.test(f)) : [];

  return {
    mode: argv.mode || 'development',
    devtool: dev ? 'source-map' : false,
    entry: {
      taskpane: './src/ui/taskpane.ts',
      commands: './src/commands/commands.ts',
      dashboard: './src/dashboard/dashboard.ts',
    },
    output: {
      path: path.resolve(__dirname, 'dist'),
      filename: '[name].[contenthash].js',
      clean: true,
    },
    resolve: {
      extensions: ['.ts', '.js'],
    },
    module: {
      rules: [
        {
          test: /\.ts$/,
          use: {
            loader: 'ts-loader',
            // tsconfig keeps noEmit:true for `tsc --noEmit` typechecks; the
            // bundler needs emit on.
            options: { compilerOptions: { noEmit: false } },
          },
          exclude: [/node_modules/, /__tests__/],
        },
        {
          test: /\.css$/,
          use: ['style-loader', 'css-loader'],
        },
      ],
    },
    plugins: [
      new HtmlWebpackPlugin({
        filename: 'taskpane.html',
        template: './src/ui/taskpane.html',
        chunks: ['taskpane'],
      }),
      new HtmlWebpackPlugin({
        filename: 'commands.html',
        template: './src/commands/commands.html',
        chunks: ['commands'],
      }),
      new HtmlWebpackPlugin({
        filename: 'dashboard.html',
        template: './src/dashboard/dashboard.html',
        chunks: ['dashboard'],
      }),
      // The dashboard is also the site's front page (GitHub Pages).
      new HtmlWebpackPlugin({
        filename: 'index.html',
        template: './src/dashboard/dashboard.html',
        chunks: ['dashboard'],
      }),
      new webpack.DefinePlugin({ __CB_EXAMPLE_FILES__: JSON.stringify(cbExampleFiles) }),
      new CopyWebpackPlugin({
        patterns: [
          { from: 'assets', to: 'assets' },
          { from: 'manifest.xml', to: 'manifest.xml' },
          // The project's own example workbooks.
          { from: 'examples/*.xlsx', to: 'examples/[name][ext]' },
          // Crystal Ball's example workbooks (tools/copy-cb-examples.sh); optional.
          { from: 'examples/crystal-ball', to: 'examples/crystal-ball', noErrorOnMissing: true },
        ],
      }),
    ],
    devServer: {
      server: httpsOptions ? { type: 'https', options: httpsOptions } : 'http',
      port: 3000,
      headers: { 'Access-Control-Allow-Origin': '*' },
      static: { directory: path.resolve(__dirname, 'dist') },
      hot: true,
    },
  };
};
