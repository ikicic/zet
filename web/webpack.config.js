const path = require("path");
const HtmlWebpackPlugin = require("html-webpack-plugin");

module.exports = {
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
    new HtmlWebpackPlugin({
      template: "./public/index.html",
    }),
  ],
  devServer: {
    static: {
      directory: path.join(__dirname, "public"),
    },
    static: {
      // For style.json.
      directory: path.join(__dirname, "BUILD"),
      publicPath: "/",
    },
    compress: true,
    port: 3000,
    hot: true,
    liveReload: true,
  },
};
