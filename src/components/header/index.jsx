import React from 'react'
import { Link } from 'gatsby'
import './index.scss'

export const Header = ({ title, location, rootPath }) => {
  const isRoot = location.pathname === rootPath
  return (
    isRoot && (
      <h1 className="home-header">
          {title}
      </h1>
    )
  )
}
