const path = require("path");
const webpack = require("webpack");
const HtmlWebpackPlugin = require("html-webpack-plugin");

module.exports = (env, argv) => ({
  mode: "development",
  entry: "./src/Index.tsx",
  output: {
    filename: "bundle.[contenthash].js",
    path: path.resolve(__dirname, "BUILD"),
  },
  module: {
    rules: [
      {
        test: /\.(ts|tsx)$/,
        exclude: /node_modules/,
        use: "ts-loader",
      },
      {
        test: /\.css$/,
        use: ["style-loader", "css-loader"],
      },
    ],
  },
  resolve: {
    extensions: [".tsx", ".ts", ".js"],
  },
  plugins: [
    new webpack.DefinePlugin({
      __DEV__: JSON.stringify((argv.mode || "development") !== "production"),
    }),
    new HtmlWebpackPlugin({
      template: "./public/index.html",
    }),
    new HtmlWebpackPlugin({
      template: "./public/privacy.html",
      filename: "privacy.html",
      inject: false,
    }),
  ],
  devServer: {
    host: "0.0.0.0",
    allowedHosts: "all",
    static: [
      {
        directory: path.join(__dirname, "public"),
      },
      {
        // For style.json.
        directory: path.join(__dirname, "BUILD"),
        publicPath: "/",
      },
    ],
    proxy: [
      {
        context: ["/static", "/api", "/ws-v2"],
        target: "http://127.0.0.1:5000",
        ws: true,
        changeOrigin: true,
      },
    ],
    compress: true,
    port: 3000,
    hot: true,
    liveReload: true,
  },
});
